import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ts } from "ts-morph";
import type { TargetConfig } from "../config/schema.js";
import { hashOf } from "../core/hash.js";
import type { DataLayout } from "../core/paths.js";
import type { CallSite, RouteDecl } from "../core/types.js";
import { type Db, getMeta, setMeta } from "../store/db.js";
import { locateRepo } from "../workspace/repos.js";
import { CallMatcher } from "./calls.js";
import { DETECTORS } from "./detectors/index.js";
import { Evaluator } from "./evaluate.js";
import { Lifter } from "./lift.js";
import { fileId, Program, type ProgramFile } from "./program.js";
import { loadRules, type RuleSet } from "./rules.js";
import { componentsOfFiles } from "./usage.js";
import { display } from "./value.js";

/** Wrapper depth for inlining helper functions while evaluating an address. */
const EVAL_DEPTH = 8;

export interface ExtractStats {
  skipped: boolean;
  files: number;
  sites: number;
  lifted: number;
  routes: number;
  byType: Record<string, number>;
  byDetector: Record<string, number>;
  seconds: { parse: number; calls: number; lift: number; routes: number; total: number };
  rssMb: number;
}

/** The inventoried snapshot as a program, files read from their checkouts. */
export function programOf(db: Db, config: TargetConfig, layout: DataLayout, configPath: string): Program {
  const files = db
    .prepare("SELECT repo_id AS repo, path, lang, component FROM file ORDER BY repo_id, path")
    .all() as ProgramFile[];
  const dirs = new Map<string, string>();
  for (const repo of config.repos) {
    if (files.some((f) => f.repo === repo.id)) dirs.set(repo.id, locateRepo(repo, layout, configPath).dir);
  }
  return new Program(files, (repo, path) => readFileSync(join(dirs.get(repo) ?? "", path), "utf8"));
}

/**
 * Finds call sites and route declarations once for the snapshot and the
 * rules; every variant of the method then reads the same rows. Skipped when
 * neither the inventory nor the rules changed since the last run.
 */
export function runExtraction(
  db: Db,
  config: TargetConfig,
  program: Program,
  opts: { force?: boolean; log?: (m: string) => void } = {},
): ExtractStats {
  const t0 = performance.now();
  const rules = loadRules(config.rules.packs);
  const key = hashOf({ inventory: getMeta(db, "inventory.hash"), rules: rules.hash, liftDepth: config.rules.liftDepth });
  if (!opts.force && getMeta(db, "extract.key") === key) {
    const previous = JSON.parse(getMeta(db, "extract.stats") ?? "{}") as ExtractStats;
    return { ...previous, skipped: true };
  }

  const files = program.codeFiles().map((f) => fileId(f.repo, f.path));
  for (const id of files) program.source(id);
  const t1 = performance.now();

  const evaluator = new Evaluator(program, { maxDepth: EVAL_DEPTH, valueSources: rules.valueSources });
  const matcher = new CallMatcher(program, evaluator, rules);
  const raw = matcher.detect(files);
  const t2 = performance.now();

  const lifter = new Lifter(program, matcher, evaluator, { maxDepth: config.rules.liftDepth, files });
  const placed = raw.flatMap((r) => lifter.place(r));
  const t3 = performance.now();

  const usage = componentsOfFiles(program);
  const sites = toSites(program, placed, usage);
  const routes = findRoutes(program, evaluator, rules, usage);
  const t4 = performance.now();

  writeSites(db, sites);
  writeRoutes(db, routes);
  const stats: ExtractStats = {
    skipped: false,
    files: files.length,
    sites: sites.length,
    lifted: sites.filter((s) => s.liftedFrom !== null).length,
    routes: routes.length,
    byType: countBy(sites, (s) => s.type),
    byDetector: countBy(sites, (s) => s.detector),
    seconds: {
      parse: round(t1 - t0),
      calls: round(t2 - t1),
      lift: round(t3 - t2),
      routes: round(t4 - t3),
      total: round(performance.now() - t0),
    },
    rssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
  };
  setMeta(db, "extract.key", key);
  setMeta(db, "extract.rulesHash", rules.hash);
  setMeta(db, "extract.stats", JSON.stringify(stats));
  return stats;
}

function toSites(program: Program, placed: ReturnType<Lifter["place"]>, usage: Map<string, string[]>): CallSite[] {
  const out: CallSite[] = [];
  const ids = new Set<string>();
  for (const p of placed) {
    const loc = location(program, p.at);
    let id = loc.id;
    for (let n = 2; ids.has(id); n++) id = `${loc.id}~${n}`;
    ids.add(id);
    out.push({
      id,
      repo: loc.repo,
      path: loc.path,
      line: loc.line,
      endLine: loc.endLine,
      col: loc.col,
      type: p.raw.binding.type,
      role: p.raw.binding.role,
      detector: p.raw.binding.qualified,
      method: p.method,
      address: p.address,
      components: usage.get(fileId(loc.repo, loc.path)) ?? [],
      liftedFrom: p.liftedFrom ? location(program, p.liftedFrom.node).id : null,
    });
  }
  return out;
}

function findRoutes(program: Program, evaluator: Evaluator, rules: RuleSet, usage: Map<string, string[]>): RouteDecl[] {
  const files = program.codeFiles();
  const out: RouteDecl[] = [];
  const ids = new Set<string>();
  for (const name of rules.detectors) {
    const detector = DETECTORS[name];
    if (!detector) continue;
    for (const r of detector.run({ program, evaluator, files })) {
      const loc = location(program, r.node);
      let id = loc.id;
      for (let n = 2; ids.has(id); n++) id = `${loc.id}#${n}`;
      ids.add(id);
      out.push({
        id,
        kind: r.kind,
        repo: loc.repo,
        path: loc.path,
        line: loc.line,
        col: loc.col,
        method: r.method,
        template: r.template,
        detector: name,
        source: "rules",
        components: usage.get(fileId(loc.repo, loc.path)) ?? [],
        extra: r.extra ?? null,
      });
    }
  }
  return out;
}

function location(program: Program, node: ts.Node) {
  const sf = node.getSourceFile();
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  const id = program.idOf(node);
  const at = id.indexOf(":");
  const repo = id.slice(0, at);
  const path = id.slice(at + 1);
  return { id: `${id}:${start.line + 1}:${start.character + 1}`, repo, path, line: start.line + 1, endLine: end.line + 1, col: start.character + 1 };
}

function writeSites(db: Db, sites: CallSite[]): void {
  const insert = db.prepare(
    `INSERT INTO call_site(id, repo, path, line, end_line, col, type, role, detector, method, address, display, components, lifted_from)
     VALUES (@id, @repo, @path, @line, @endLine, @col, @type, @role, @detector, @method, @address, @display, @components, @liftedFrom)`,
  );
  db.transaction(() => {
    db.exec("DELETE FROM call_site");
    for (const s of sites) {
      insert.run({
        ...s,
        method: s.method ? JSON.stringify(s.method) : null,
        address: JSON.stringify(s.address),
        display: display(s.address),
        components: JSON.stringify(s.components),
      });
    }
  })();
}

function writeRoutes(db: Db, routes: RouteDecl[]): void {
  const insert = db.prepare(
    `INSERT INTO route(id, kind, repo, path, line, col, method, template, detector, source, components, extra)
     VALUES (@id, @kind, @repo, @path, @line, @col, @method, @template, @detector, @source, @components, @extra)`,
  );
  db.transaction(() => {
    db.exec("DELETE FROM route WHERE source = 'rules'");
    for (const r of routes) insert.run({ ...r, components: JSON.stringify(r.components), extra: r.extra ? JSON.stringify(r.extra) : null });
  })();
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function round(ms: number): number {
  return Math.round(ms / 10) / 100;
}

/** Stored sites, as the later steps and the tests read them. */
export function loadSites(db: Db): CallSite[] {
  return (
    db.prepare("SELECT * FROM call_site ORDER BY repo, path, line, col").all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    repo: String(r.repo),
    path: String(r.path),
    line: Number(r.line),
    endLine: Number(r.end_line),
    col: Number(r.col),
    type: r.type as CallSite["type"],
    role: r.role as CallSite["role"],
    detector: String(r.detector),
    method: r.method ? JSON.parse(String(r.method)) : null,
    address: JSON.parse(String(r.address)),
    components: JSON.parse(String(r.components)) as string[],
    liftedFrom: r.lifted_from ? String(r.lifted_from) : null,
  }));
}

export function loadRoutes(db: Db): RouteDecl[] {
  return (db.prepare("SELECT * FROM route ORDER BY repo, path, line, col, id").all() as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    kind: r.kind as RouteDecl["kind"],
    repo: String(r.repo),
    path: String(r.path),
    line: Number(r.line),
    col: Number(r.col),
    method: r.method ? String(r.method) : null,
    template: String(r.template),
    detector: String(r.detector),
    source: r.source as RouteDecl["source"],
    components: JSON.parse(String(r.components)) as string[],
    extra: r.extra ? (JSON.parse(String(r.extra)) as Record<string, unknown>) : null,
  }));
}
