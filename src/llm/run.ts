import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import type { DataLayout } from "../core/paths.js";
import type { CallSite, RouteDecl } from "../core/types.js";
import { loadUsage } from "../extract/run.js";
import { loadRules } from "../extract/rules.js";
import { loadInfra } from "../infra/index.js";
import { rankCandidates } from "../match/candidates.js";
import { loadLinks, matchingOf, sourcesOf, type StoredLink, type Variant } from "../match/run.js";
import { type Db, setMeta } from "../store/db.js";
import { locateRepo } from "../workspace/repos.js";
import { type LlmClient, repeatsOf } from "./client.js";
import { assignIds, chunksOf, extractionRequest, filesForExtraction, type RouteAnswer, routesFromAnswer, type SourceFile } from "./tasks/extractRoutes.js";
import {
  chosen,
  type FreeAnswer,
  fragmentOf,
  freeRequest,
  methodCatalog,
  normaliseFree,
  type SelectAnswer,
  selectRequest,
  systemDescription,
} from "./tasks/resolve.js";
import type { LlmAnswer, LlmRequest } from "./types.js";

/** Reads files of the inventoried snapshot. */
export function reader(config: TargetConfig, layout: DataLayout, configPath: string): (repo: string, path: string) => string {
  const dirs = new Map<string, string>();
  return (repo, path) => {
    let dir = dirs.get(repo);
    if (dir === undefined) {
      const r = config.repos.find((x) => x.id === repo);
      if (!r) throw new Error(`unknown repository ${repo}`);
      dir = locateRepo(r, layout, configPath).dir;
      dirs.set(repo, dir);
    }
    return readFileSync(join(dir, path), "utf8");
  };
}

/**
 * Whether a file may be sent to the client's model: always for a local
 * model; for the cloud model only files of publishable licence zones,
 * unless the config allows the rest.
 */
export function sendable(db: Db, config: TargetConfig, client: LlmClient): (repo: string, path: string) => boolean {
  if (client.tag !== "cloud" || config.llm.cloud.sendNonPublishable) return () => true;
  const closed = new Set((db.prepare("SELECT repo_id || ':' || path AS id FROM file WHERE publishable = 0").all() as Array<{ id: string }>).map((r) => r.id));
  return (repo, path) => !closed.has(`${repo}:${path}`);
}

export interface RoutesSummary {
  files: number;
  requests: number;
  routes: number;
  byKind: Record<string, number>;
  failed: number;
  costUsd: number;
  cacheHits: number;
}

/**
 * Task (a): the model reads every server file that may declare routes by a
 * mechanism and lists the declarations. They replace the earlier extracted
 * routes (source `llm`); rule routes are untouched.
 */
export async function runLlmRoutes(db: Db, config: TargetConfig, read: (repo: string, path: string) => string, client: LlmClient, opts: { files?: (f: SourceFile) => boolean } = {}): Promise<RoutesSummary> {
  const usage = loadUsage(db);
  const allowed = sendable(db, config, client);
  const code = (db.prepare("SELECT repo_id AS repo, path FROM file WHERE lang IN ('ts', 'tsx', 'js', 'jsx') ORDER BY repo_id, path").all() as Array<{ repo: string; path: string }>).filter(
    (f) => allowed(f.repo, f.path),
  );
  const files: SourceFile[] = code.map((f) => ({ ...f, text: read(f.repo, f.path), components: usage.get(`${f.repo}:${f.path}`) ?? [] }));
  const clients = new Set(config.components.filter((c) => c.kind === "client").map((c) => c.id));
  const chosenFiles = filesForExtraction(files, config.llm.extract.hints, clients).filter((f) => opts.files?.(f) ?? true);
  const chunking = { enabled: client.tag === "cloud" ? config.llm.chunking.cloud : config.llm.chunking.local, maxTokens: config.llm.chunking.maxTokens };
  const chunks = chosenFiles.flatMap((f) => chunksOf(f, chunking));
  const effort = config.llm.cloud.effort.extract;
  const requests = chunks.map((c) => extractionRequest(c, config.name, effort));
  const repeats = repeatsOf(requests, config.llm.stability.share, config.llm.stability.repeats, (r) => client.keyOf(r));
  const answers = await client.askMany([...requests, ...repeats]);
  const routes: RouteDecl[] = [];
  let failed = 0;
  chunks.forEach((chunk, i) => {
    const a = answers[i] as LlmAnswer<RouteAnswer>;
    if (!a.parsed) failed++;
    routes.push(...routesFromAnswer(chunk, a, client.model));
  });
  const unique = assignIds(routes);
  const insert = db.prepare(
    `INSERT INTO route(id, kind, repo, path, line, col, method, template, detector, source, components, extra)
     VALUES (@id, @kind, @repo, @path, @line, @col, @method, @template, @detector, @source, @components, NULL)`,
  );
  db.transaction(() => {
    db.exec("DELETE FROM route WHERE source = 'llm'");
    for (const r of unique) insert.run({ ...r, components: JSON.stringify(r.components) });
    setMeta(db, "llm.routes", JSON.stringify({ model: client.model, provider: client.tag, files: chosenFiles.length, routes: unique.length, at: new Date().toISOString() }));
  })();
  const byKind: Record<string, number> = {};
  for (const r of unique) byKind[`${r.kind}${r.method && r.kind === "ddp-method" ? `:${r.method}` : ""}`] = (byKind[`${r.kind}${r.method && r.kind === "ddp-method" ? `:${r.method}` : ""}`] ?? 0) + 1;
  return { files: chosenFiles.length, requests: requests.length + repeats.length, routes: unique.length, byKind, failed, costUsd: client.stats.costUsd, cacheHits: client.stats.cacheHits };
}

export interface ResolveOptions {
  /** The matching run to start from: its links stay where the model is not asked. */
  base: string;
  mode: "select" | "free";
  /** `open`: only the sites the base run left ambiguous or unresolved; `all`: every site (hypothesis 2). */
  scope: "open" | "all";
  /** Restricts the sites asked about, e.g. to the labelled sample. */
  sites?: (site: CallSite) => boolean;
  configHash: string;
}

export interface ResolveSummary {
  run: string;
  asked: number;
  linked: number;
  none: number;
  invented: number;
  failed: number;
  costUsd: number;
  cacheHits: number;
  requests: number;
}

/**
 * Tasks (b) and (c): the model resolves call sites in select mode (one of
 * the rules' candidates, or none) or free mode (names the target itself).
 * The result is a new run, `<base>.<mode>[-all].<local|cloud>`: the base
 * run's links with the model's decisions on the sites it was asked about.
 */
export async function runResolve(db: Db, config: TargetConfig, read: (repo: string, path: string) => string, client: LlmClient, opts: ResolveOptions): Promise<ResolveSummary> {
  const baseRow = db.prepare("SELECT variant FROM run WHERE id = ?").get(opts.base) as { variant: string } | undefined;
  if (!baseRow) throw new Error(`no run ${opts.base}; run \`archmap match\` first`);
  const variant = JSON.parse(baseRow.variant) as Variant;
  const sources = sourcesOf(variant);
  const { resolver, sites } = matchingOf(db, config);
  const links = new Map(loadLinks(db, opts.base).map((l) => [l.site, l]));
  const rules = loadRules(config.rules.packs);
  const infra = loadInfra(db);
  const system = systemDescription({ config, infra, routes: [...resolver.routesOf("http", sources), ...resolver.routesOf("broker-action", sources)], sites, sources, guards: rules.matching.guards });
  const catalog = methodCatalog(resolver, sites, sources);
  const aliases = new Map<string, string>();
  for (const c of config.components) for (const a of [c.id, ...c.aliases]) aliases.set(a.toLowerCase(), c.id);
  for (const c of infra.containers) if (c.component) for (const h of [c.name, ...c.hostnames]) aliases.set(h.toLowerCase(), c.component);
  const partOf = (name: string) => aliases.get(name.trim().toLowerCase()) ?? null;
  const httpBases = [...new Set(rules.bindings.flatMap((b) => (b.base ?? []).flatMap((spec) => ("value" in spec ? [spec.value] : []))))];
  const conventions = { httpBases, subscriptionPrefixes: rules.matching.subscriptionPrefixes };

  const allowed = sendable(db, config, client);
  const targets = sites.filter((s) => {
    const l = links.get(s.id);
    if (!l || !allowed(s.repo, s.path)) return false;
    if (opts.scope === "open" && l.status !== "ambiguous" && l.status !== "unresolved") return false;
    return opts.sites?.(s) ?? true;
  });
  const effort = opts.mode === "select" ? config.llm.cloud.effort.select : config.llm.cloud.effort.free;
  const asks: Array<{ site: CallSite; req: LlmRequest<SelectAnswer> | LlmRequest<FreeAnswer>; candidates: string[] }> = [];
  const skipped: CallSite[] = [];
  for (const site of targets) {
    const code = fragmentOf(read(site.repo, site.path), site, config.llm.resolve.contextLines);
    const common = { project: config.name, system, path: `${site.repo}:${site.path}`, code, subject: site.id, effort };
    if (opts.mode === "free") {
      asks.push({ site, req: freeRequest(common), candidates: [] });
      continue;
    }
    const r = resolver.resolve(site, sources);
    const open = r.status === "linked" ? { ...r, alternatives: r.alternatives.length > 0 ? r.alternatives : [r.target as string] } : r;
    const candidates = rankCandidates(resolver, site, open, sources, config.llm.resolve.candidates).map((c) => c.target);
    if (candidates.length === 0) skipped.push(site);
    else asks.push({ site, req: selectRequest({ ...common, candidates }), candidates });
  }
  const reqs = asks.map((a) => a.req as LlmRequest);
  const repeats = repeatsOf(reqs, config.llm.stability.share, config.llm.stability.repeats, (r) => client.keyOf(r));
  const answers = await client.askMany([...reqs, ...repeats]);

  const decisions = new Map<string, Partial<StoredLink> & { llmAnswer: string }>();
  let invented = 0;
  let failed = 0;
  asks.forEach((ask, i) => {
    const a = answers[i] as LlmAnswer;
    const llmAnswer = client.keyOf(ask.req as LlmRequest);
    if (a.parsed === null) {
      failed++;
      decisions.set(ask.site.id, { status: "unresolved", target: null, reason: `llm-${a.stopReason ?? "failed"}`, llmAnswer });
      return;
    }
    let key: string | null;
    if (opts.mode === "select") key = chosen(a.parsed as SelectAnswer, ask.candidates);
    else {
      const n = normaliseFree(a.parsed as FreeAnswer, { resolver, catalog, partOf, sources, conventions });
      key = n.key;
      if (n.invented) invented++;
      if (n.invented) {
        decisions.set(ask.site.id, { status: "none", target: null, reason: `llm-invented:${n.proposed}`, llmAnswer });
        return;
      }
    }
    decisions.set(ask.site.id, key ? { status: "linked", target: key, reason: null, llmAnswer } : { status: "none", target: null, reason: "llm-none", llmAnswer });
  });
  for (const site of skipped) decisions.set(site.id, { status: "unresolved", target: null, reason: "no-candidates", llmAnswer: "" });

  const id = `${opts.base}.${opts.mode}${opts.scope === "all" ? "-all" : ""}.${client.tag}`;
  const insert = db.prepare(
    `INSERT INTO link(run, site, status, target, route, component, reason, via, provenance, case_no, alternatives, llm_answer)
     VALUES (@run, @site, @status, @target, @route, @component, @reason, @via, @provenance, @caseNo, @alternatives, @llmAnswer)`,
  );
  let linked = 0;
  let none = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM run WHERE id = ?").run(id);
    db.prepare(
      `INSERT INTO run(id, created_at, variant, llm_mode, models, tool_sha, config_hash, inputs, timings, cost_usd)
       SELECT ?, ?, variant, ?, ?, tool_sha, ?, inputs, timings, ? FROM run WHERE id = ?`,
    ).run(id, new Date().toISOString(), opts.mode, JSON.stringify({ provider: client.tag, model: client.model, answeredBy: client.stats.models, scope: opts.scope }), opts.configHash, client.stats.costUsd, opts.base);
    for (const l of links.values()) {
      const d = decisions.get(l.site);
      const merged = d
        ? {
            ...l,
            status: d.status ?? l.status,
            target: d.target ?? null,
            route: null,
            component: d.target ? d.target.slice(d.target.lastIndexOf("@") + 1) : null,
            reason: d.reason ?? null,
            provenance: d.status === "linked" ? "llm" : null,
            alternatives: [],
            llmAnswer: d.llmAnswer || null,
          }
        : { ...l, llmAnswer: null };
      if (d?.status === "linked") linked++;
      if (d?.status === "none") none++;
      insert.run({
        run: id,
        site: merged.site,
        status: merged.status,
        target: merged.target,
        route: merged.route,
        component: merged.component,
        reason: merged.reason,
        via: JSON.stringify(merged.via),
        provenance: merged.provenance,
        caseNo: merged.caseNo,
        alternatives: JSON.stringify(merged.alternatives),
        llmAnswer: merged.llmAnswer,
      });
    }
  })();
  return { run: id, asked: asks.length, linked, none, invented, failed, costUsd: client.stats.costUsd, cacheHits: client.stats.cacheHits, requests: reqs.length + repeats.length };
}
