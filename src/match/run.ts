import type { TargetConfig } from "../config/schema.js";
import { hashOf } from "../core/hash.js";
import { toolRoot } from "../core/paths.js";
import type { CallSite } from "../core/types.js";
import { loadRoutes, loadSites } from "../extract/run.js";
import { loadRules } from "../extract/rules.js";
import { loadInfra } from "../infra/index.js";
import { type Db, getMeta } from "../store/db.js";
import { git } from "../workspace/git.js";
import { rankCandidates } from "./candidates.js";
import { Resolver, type Sources } from "./resolve.js";

/** Which sources of evidence a run of the method uses. */
export interface Variant {
  rules: boolean;
  infra: boolean;
  llm: boolean;
}

export const FULL: Variant = { rules: true, infra: true, llm: true };

/** `full`, or the sources switched off: `no-infra`, `no-rules+no-llm`. */
export function variantName(v: Variant): string {
  const off = [!v.rules && "no-rules", !v.infra && "no-infra", !v.llm && "no-llm"].filter((x): x is string => typeof x === "string");
  return off.length === 0 ? "full" : off.join("+");
}

export function sourcesOf(v: Variant): Sources {
  return { rules: v.rules, llmRoutes: v.llm, env: v.infra, gateway: v.infra };
}

export interface Matching {
  resolver: Resolver;
  sites: CallSite[];
  /** What the answers depend on: the extraction, the infrastructure facts, the rules. */
  inputs: { extract: string | null; infra: string | null; rules: string; llmRoutes: string };
}

/** A resolver over the stored extraction and infrastructure facts of a target. */
export function matchingOf(db: Db, config: TargetConfig): Matching {
  const sites = loadSites(db);
  const routes = loadRoutes(db);
  const rules = loadRules(config.rules.packs);
  const resolver = new Resolver({
    sites,
    routes,
    infra: loadInfra(db),
    components: config.components,
    profileEnv: config.infra.env,
    options: rules.matching,
  });
  const llmRoutes = hashOf(routes.filter((r) => r.source === "llm").map((r) => [r.id, r.kind, r.method, r.template, r.components]));
  return {
    resolver,
    sites,
    inputs: { extract: getMeta(db, "extract.key") ?? null, infra: getMeta(db, "infra.key") ?? null, rules: rules.hash, llmRoutes },
  };
}

export interface MatchSummary {
  run: string;
  sites: number;
  byStatus: Record<string, number>;
  linkedByType: Record<string, number>;
  byProvenance: Record<string, number>;
  seconds: number;
}

/**
 * Matches every call site under a variant and stores the run: one link row
 * per site (linked, none, ambiguous or unresolved) and, for the sites the
 * rules leave open, the candidates for the language model's select mode.
 * The run id is the variant's name, so running a variant again replaces it.
 */
export function runMatch(db: Db, config: TargetConfig, variant: Variant, opts: { configHash: string; cases?: Map<string, number | null> }): MatchSummary {
  const t0 = performance.now();
  const id = variantName(variant);
  const sources = sourcesOf(variant);
  const { resolver, sites, inputs } = matchingOf(db, config);
  const cases = opts.cases ?? loadCases(db);
  const links = sites.map((site) => {
    const r = resolver.resolve(site, sources);
    let provenance: string | null = null;
    if (r.status === "linked") {
      const plain = resolver.resolve(site, { ...sources, env: false, gateway: false });
      provenance = plain.status === "linked" && plain.target === r.target ? "rules" : "infra";
    }
    const candidates = r.status === "ambiguous" || r.status === "unresolved" ? rankCandidates(resolver, site, r, sources) : [];
    return { site, r, provenance, candidates };
  });
  const seconds = Math.round((performance.now() - t0) / 10) / 100;

  const insertLink = db.prepare(
    `INSERT INTO link(run, site, status, target, route, component, reason, via, provenance, case_no, alternatives)
     VALUES (@run, @site, @status, @target, @route, @component, @reason, @via, @provenance, @caseNo, @alternatives)`,
  );
  const insertCandidate = db.prepare("INSERT INTO candidate(run, site, rank, target, route, score) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM run WHERE id = ?").run(id);
    db.prepare(
      `INSERT INTO run(id, created_at, variant, llm_mode, models, tool_sha, config_hash, inputs, timings, cost_usd)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0)`,
    ).run(id, new Date().toISOString(), JSON.stringify(variant), toolSha(), opts.configHash, JSON.stringify(inputs), JSON.stringify({ match: seconds }));
    for (const { site, r, provenance, candidates } of links) {
      insertLink.run({
        run: id,
        site: site.id,
        status: r.status,
        target: r.target,
        route: r.route,
        component: r.component,
        reason: r.reason,
        via: JSON.stringify(r.via),
        provenance,
        caseNo: cases.get(site.id) ?? null,
        alternatives: JSON.stringify(r.alternatives),
      });
      candidates.forEach((c, i) => insertCandidate.run(id, site.id, i + 1, c.target, c.route, c.score));
    }
  })();

  return {
    run: id,
    sites: sites.length,
    byStatus: countBy(links, (l) => l.r.status),
    linkedByType: countBy(
      links.filter((l) => l.r.status === "linked"),
      (l) => l.site.type,
    ),
    byProvenance: countBy(
      links.filter((l) => l.provenance !== null),
      (l) => l.provenance as string,
    ),
    seconds,
  };
}

function loadCases(db: Db): Map<string, number | null> {
  const rows = db.prepare("SELECT site, case_no FROM classification").all() as Array<{ site: string; case_no: number | null }>;
  return new Map(rows.map((r) => [r.site, r.case_no]));
}

/** Commit of the tool's own repository, when it is one. */
function toolSha(): string | null {
  try {
    return git(["rev-parse", "HEAD"], toolRoot).trim();
  } catch {
    return null;
  }
}

export function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface StoredLink {
  site: string;
  status: string;
  target: string | null;
  route: string | null;
  component: string | null;
  reason: string | null;
  via: string[];
  provenance: string | null;
  caseNo: number | null;
  alternatives: string[];
}

export function loadLinks(db: Db, run: string): StoredLink[] {
  return (db.prepare("SELECT * FROM link WHERE run = ? ORDER BY site").all(run) as Array<Record<string, unknown>>).map((r) => ({
    site: String(r.site),
    status: String(r.status),
    target: r.target === null ? null : String(r.target),
    route: r.route === null ? null : String(r.route),
    component: r.component === null ? null : String(r.component),
    reason: r.reason === null ? null : String(r.reason),
    via: JSON.parse(String(r.via)) as string[],
    provenance: r.provenance === null ? null : String(r.provenance),
    caseNo: r.case_no === null ? null : Number(r.case_no),
    alternatives: JSON.parse(String(r.alternatives)) as string[],
  }));
}

export function loadCandidates(db: Db, run: string, site: string): Array<{ rank: number; target: string; route: string | null; score: number }> {
  return db.prepare("SELECT rank, target, route, score FROM candidate WHERE run = ? AND site = ? ORDER BY rank").all(run, site) as Array<{
    rank: number;
    target: string;
    route: string | null;
    score: number;
  }>;
}
