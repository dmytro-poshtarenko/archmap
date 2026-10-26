import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import { loadSites } from "../extract/run.js";
import { loadLinks } from "../match/run.js";
import { type Db, getMeta } from "../store/db.js";
import { renderModel } from "./dsl.js";
import { type Feature, type FeatureRequest, featureOf, renderFeature, slugOf } from "./feature.js";
import { buildGraph, type ExternalCall, type GatewayRoute, type MapGraph, SYSTEM } from "./graph.js";
import { type Diagnostic, validateWorkspace } from "./validate.js";

/** The model file of a map: named so the viewer lists its C1, C2 and C3 views before the feature views. */
export const MODEL_FILE = "c4-model.c4";

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

/** The product's name on the map: the last part of the main repository's URL (`Rocket.Chat`), else the config's name. */
export function productName(config: TargetConfig): string {
  const url = config.repos.find((r) => r.role === "main" && r.url)?.url;
  return url?.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? config.name;
}

export function graphOf(db: Db, config: TargetConfig, run: string): MapGraph {
  const links = loadLinks(db, run);
  if (links.length === 0) throw new Error(`run '${run}' has no links; run \`archmap match\` first`);
  return buildGraph(config, run, loadSites(db), links, { routing: loadRouting(db), externals: loadExternals(db, run), product: productName(config) });
}

/**
 * Calls the run sends outside the system, with the URL they reach. A base
 * address taken from a setting gets the setting's default value from the code
 * (`{setting:Cloud_Url}` → `https://cloud.rocket.chat`).
 */
function loadExternals(db: Db, run: string): ExternalCall[] {
  const defaults = JSON.parse(getMeta(db, "extract.settingDefaults") ?? "{}") as Record<string, string>;
  const rows = db
    .prepare(
      `SELECT s.id AS site, s.display, s.components FROM link l JOIN call_site s ON s.id = l.site
       WHERE l.run = ? AND l.status = 'none' AND l.reason = 'external'`,
    )
    .all(run) as Array<{ site: string; display: string; components: string }>;
  return rows
    .map((r) => ({ site: r.site, url: r.display.replace(/^\{setting:([^}]+)\}/, (whole, key: string) => defaults[key] ?? whole), components: JSON.parse(r.components) as string[] }))
    .filter((c) => /^https?:\/\//.test(c.url));
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
 * Writes the LikeC4 workspace of a run (`c4-model.c4`, keeping the feature
 * views made earlier) and validates it. A valid map becomes the one `current`
 * points to, when that link is given.
 */
export async function buildMap(db: Db, config: TargetConfig, run: string, dir: string, current?: string): Promise<{ graph: MapGraph; diagnostics: Diagnostic[] }> {
  const graph = graphOf(db, config, run);
  mkdirSync(dir, { recursive: true });
  const product = productName(config);
  const containers = graph.elements.filter((e) => e.parent === null && e.kind !== "system" && e.kind !== "external").length;
  const links = graph.relations.filter((r) => r.source !== SYSTEM).length;
  const about = `${product}: ${containers} containers, the external systems they call, and ${links} links between them, found by run ${run}. Hover an element or an arrow for its routes and callers.`;
  rmSync(join(dir, "model.c4"), { force: true }); // the name maps had before the C4 levels
  writeFileSync(join(dir, MODEL_FILE), renderModel(graph, product, about));
  // the viewer's tab and project title
  writeFileSync(join(dir, "likec4.config.json"), `${JSON.stringify({ name: config.name, title: `${product}: C4 Diagrams` }, null, 2)}\n`);
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

/** Removes a feature view, named by its view id (`feature_user_presence`) or by the name it was made with. */
export function removeFeatureView(dir: string, view: string): string {
  const slug = view.startsWith("feature_") && existsSync(join(dir, `${view}.c4`)) ? view.slice("feature_".length) : slugOf(view);
  const file = join(dir, `feature_${slug}.c4`);
  if (!existsSync(file)) throw new Error(`no feature view ${view} in ${dir}`);
  rmSync(file);
  return `feature_${slug}`;
}

export function featureFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^feature_.*\.c4$/.test(f));
}
