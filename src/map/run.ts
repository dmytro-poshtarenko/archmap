import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import { loadSites } from "../extract/run.js";
import { loadLinks } from "../match/run.js";
import type { Db } from "../store/db.js";
import { renderModel } from "./dsl.js";
import { type Feature, type FeatureRequest, featureOf, renderFeature } from "./feature.js";
import { buildGraph, type MapGraph } from "./graph.js";
import { type Diagnostic, validateWorkspace } from "./validate.js";

export function mapDir(dataRoot: string, target: string, run: string): string {
  return join(dataRoot, "out", target, run, "likec4");
}

export function graphOf(db: Db, config: TargetConfig, run: string): MapGraph {
  const links = loadLinks(db, run);
  if (links.length === 0) throw new Error(`run '${run}' has no links; run \`archmap match\` first`);
  return buildGraph(config, run, loadSites(db), links);
}

/**
 * Writes the LikeC4 workspace of a run (`model.c4`, keeping the feature
 * views made earlier) and validates it.
 */
export async function buildMap(db: Db, config: TargetConfig, run: string, dir: string): Promise<{ graph: MapGraph; diagnostics: Diagnostic[] }> {
  const graph = graphOf(db, config, run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "model.c4"), renderModel(graph, `${config.name}: inter-service links (${run})`));
  return { graph, diagnostics: await validateWorkspace(dir) };
}

/** Adds (or replaces) a feature view in a built workspace and validates it. */
export async function addFeatureView(graph: MapGraph, dir: string, req: FeatureRequest): Promise<{ feature: Feature; diagnostics: Diagnostic[] }> {
  const feature = featureOf(graph, req);
  if (feature.elements.length === 0) throw new Error(`no element matches the seeds ${req.seeds.join(", ")}`);
  writeFileSync(join(dir, `feature_${feature.slug}.c4`), renderFeature(feature, req.name));
  return { feature, diagnostics: await validateWorkspace(dir) };
}

export function featureFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^feature_.*\.c4$/.test(f));
}
