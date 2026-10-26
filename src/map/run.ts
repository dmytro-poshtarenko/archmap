import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import { loadSites } from "../extract/run.js";
import { loadLinks } from "../match/run.js";
import type { Db } from "../store/db.js";
import { renderModel } from "./dsl.js";
import { type Feature, type FeatureRequest, featureOf, renderFeature } from "./feature.js";
import { buildGraph, type GatewayRoute, type MapGraph } from "./graph.js";
import { type Diagnostic, validateWorkspace } from "./validate.js";

export function mapDir(dataRoot: string, target: string, run: string): string {
  return join(dataRoot, "out", target, run, "likec4");
}

/** The map built last: `data/out/<target>/current`, a link to that run's LikeC4 workspace. */
export function currentMapDir(dataRoot: string, target: string): string {
  return join(dataRoot, "out", target, "current");
}

/** The run of the map built last, when there is one. */
export function currentMapRun(dataRoot: string, target: string): string | null {
  const link = currentMapDir(dataRoot, target);
  if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) return null;
  return basename(dirname(readlinkSync(link)));
}

/** The run a map is drawn from by default: the full method with the model's answers when it exists, else the rules and infrastructure alone. */
export function defaultMapRun(db: Db): string {
  const derived = db.prepare("SELECT id FROM run WHERE id LIKE 'full.select.%' ORDER BY created_at DESC LIMIT 1").pluck().get() as string | undefined;
  return derived ?? "full";
}

export function graphOf(db: Db, config: TargetConfig, run: string): MapGraph {
  const links = loadLinks(db, run);
  if (links.length === 0) throw new Error(`run '${run}' has no links; run \`archmap match\` first`);
  return buildGraph(config, run, loadSites(db), links, loadRouting(db));
}

/** The gateways' routing rules by the part each sends requests to, from the infrastructure step. */
function loadRouting(db: Db): GatewayRoute[] {
  const rows = db
    .prepare(
      `SELECT gw.component AS gateway, t.component AS target, g.path, g.source
       FROM gateway_rule g JOIN container gw ON gw.name = g.gateway JOIN container t ON t.name = g.target
       WHERE gw.component IS NOT NULL AND t.component IS NOT NULL`,
    )
    .all() as Array<{ gateway: string; target: string; path: string; source: string }>;
  const routes = new Map<string, GatewayRoute>();
  for (const r of rows) {
    const key = `${r.gateway}|${r.target}`;
    const route = routes.get(key) ?? { gateway: r.gateway, target: r.target, paths: [], sources: [] };
    route.paths.push(r.path);
    route.sources.push(r.source);
    routes.set(key, route);
  }
  return [...routes.values()];
}

/**
 * Writes the LikeC4 workspace of a run (`model.c4`, keeping the feature
 * views made earlier) and validates it. A valid map becomes the one `current`
 * points to, when that link is given.
 */
export async function buildMap(db: Db, config: TargetConfig, run: string, dir: string, current?: string): Promise<{ graph: MapGraph; diagnostics: Diagnostic[] }> {
  const graph = graphOf(db, config, run);
  mkdirSync(dir, { recursive: true });
  const parts = graph.elements.filter((e) => e.parent === null).length;
  const about = `Inter-service links of ${config.name} found by run ${run}: ${parts} parts, ${graph.relations.length} links between them. Hover an element or an arrow for its routes and callers.`;
  writeFileSync(join(dir, "model.c4"), renderModel(graph, `${config.name}: system map`, about));
  const diagnostics = await validateWorkspace(dir);
  if (current && diagnostics.length === 0) pointCurrent(current, dir);
  return { graph, diagnostics };
}

function pointCurrent(link: string, dir: string): void {
  try {
    if (lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { force: true });
    symlinkSync(relative(dirname(link), dir), link, "dir");
  } catch {
    // a file system without symbolic links: commands then name the run
  }
}

/** Adds (or replaces) a feature view in a built workspace and validates it. */
export async function addFeatureView(graph: MapGraph, dir: string, req: FeatureRequest, run: string): Promise<{ feature: Feature; diagnostics: Diagnostic[] }> {
  const feature = featureOf(graph, req);
  if (feature.elements.length === 0) throw new Error(`no element matches the seeds ${req.seeds.join(", ")}`);
  writeFileSync(join(dir, `feature_${feature.slug}.c4`), renderFeature(feature, req, run));
  return { feature, diagnostics: await validateWorkspace(dir) };
}

export function featureFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^feature_.*\.c4$/.test(f));
}
