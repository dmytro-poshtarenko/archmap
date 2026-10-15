import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import { mulberry32, seedFrom } from "../core/prng.js";
import { typedRoutes } from "../eval/restTypings.js";
import type { Program } from "../extract/program.js";
import type { LlmClient } from "../llm/client.js";
import { chunksOf, extractionRequest, type RouteAnswer } from "../llm/tasks/extractRoutes.js";
import { type ProbeAnswer, probeRequest } from "../llm/tasks/probe.js";
import type { LlmAnswer, LlmProvider } from "../llm/types.js";
import type { Db } from "../store/db.js";
import { type Controller, found, paddingStatements, prepareController, type Variant, variantsOf } from "./h3.js";

/** Target sizes of the padded length levels, in characters (about 6k to 96k tokens of code). */
export const LEVEL_CHARS = [18_000, 36_000, 72_000, 144_000, 288_000];
/** Size of the position series. */
export const POSITION_CHARS = 72_000;
const CONTROLLERS = 12;
const POSITION_CONTROLLERS = 6;

export interface H3Manifest {
  target: string;
  seed: number;
  createdAt: string;
  levels: number[];
  positionChars: number;
  controllers: Array<Omit<Controller, "text">>;
  variants: Array<Omit<Variant, "text"> & { file: string }>;
}

export function h3Dir(dataRoot: string, target: string): string {
  return join(dataRoot, "out", target, "h3");
}

/**
 * Generates the variants from the dev split's MIT zone only: the twelve
 * smallest REST controllers with at least two routes typed in rest-typings
 * (the routes are those the detector finds); padding from server files of
 * the same zone that declare
 * nothing. Six length levels per controller (72 variants) and, for the first
 * six controllers, three positions of the routes (18 variants).
 */
export function generateH3(db: Db, config: TargetConfig, program: Program, read: (repo: string, path: string) => string, outDir: string, seed: number): H3Manifest {
  const typed = new Set(typedRoutes(program, "main").map((t) => `${t.method.toUpperCase()} ${t.path.replace(/\/:[A-Za-z_]\w*/g, "/:p")}`));
  const rows = db
    .prepare(
      `SELECT r.repo, r.path, f.bytes, group_concat(r.method || ' ' || r.template, '|') AS routes, count(*) AS n
       FROM route r JOIN file f ON f.repo_id = r.repo AND f.path = r.path
       WHERE r.source = 'rules' AND r.kind = 'http' AND r.detector = 'rocketchat-api' AND f.split = 'dev' AND f.publishable = 1
       GROUP BY r.repo, r.path HAVING n >= 2 ORDER BY f.bytes, r.path`,
    )
    .all() as Array<{ repo: string; path: string; bytes: number; routes: string }>;
  // anchored in the typed catalog: at least two routes typed in rest-typings; the routes themselves come from the detector (AST)
  const eligible = rows.filter((r) => r.routes.split("|").filter((x) => typed.has(x.replace(/\/:[A-Za-z_]\w*/g, "/:p"))).length >= 2);
  if (eligible.length < CONTROLLERS) throw new Error(`only ${eligible.length} dev controllers with at least two typed routes`);

  const hints = config.llm.extract.hints.map((h) => new RegExp(h));
  // padding only from files that declare nothing: no route the rules find and no extraction hint
  const padFiles = db
    .prepare(
      `SELECT f.repo_id AS repo, f.path FROM file f WHERE f.split = 'dev' AND f.publishable = 1 AND f.component = 'rocketchat' AND f.lang = 'ts'
       AND NOT EXISTS (SELECT 1 FROM route r WHERE r.repo = f.repo_id AND r.path = f.path) ORDER BY f.path`,
    )
    .all() as Array<{ repo: string; path: string }>;
  const pool: string[] = [];
  for (const f of padFiles) {
    const text = read(f.repo, f.path);
    if (hints.some((h) => h.test(text))) continue;
    for (const s of paddingStatements(text, f.path)) if (s.length <= 6000) pool.push(s);
  }

  const rng = mulberry32(seedFrom(seed, "h3-names"));
  const taken = new Set<string>(db.prepare("SELECT template FROM route").pluck().all() as string[]);
  const controllers = eligible.slice(0, CONTROLLERS).map((r, i) => prepareController(`c${String(i + 1).padStart(2, "0")}`, `${r.repo}:${r.path}`, r.path, read(r.repo, r.path), rng, taken));
  const variants = controllers.flatMap((c, i) => variantsOf(c, pool, LEVEL_CHARS, i < POSITION_CONTROLLERS ? POSITION_CHARS : null, seed));

  mkdirSync(join(outDir, "variants"), { recursive: true });
  for (const v of variants) writeFileSync(join(outDir, "variants", `${v.id}.ts`), v.text);
  const manifest: H3Manifest = {
    target: config.name,
    seed,
    createdAt: new Date().toISOString(),
    levels: LEVEL_CHARS,
    positionChars: POSITION_CHARS,
    controllers: controllers.map(({ text: _text, ...c }) => c),
    variants: variants.map(({ text: _text, ...v }) => ({ ...v, file: `variants/${v.id}.ts` })),
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function loadManifest(outDir: string): H3Manifest {
  return JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as H3Manifest;
}

export interface H3Row {
  controller: string;
  variant: string;
  series: string;
  level: string;
  model: string;
  tokens: number;
  position: number;
  route: string;
  found: number;
  stop: string;
}

/**
 * Asks the model to extract the routes of every variant, as task (a) does
 * in the method, but always with the whole file, and records for each route
 * whether it was found, with the prompt's length in the model's own tokens.
 */
export async function runH3(outDir: string, config: TargetConfig, client: LlmClient, counter: LlmProvider): Promise<H3Row[]> {
  const manifest = loadManifest(outDir);
  const chunks = manifest.variants.map((v) => {
    const text = readFileSync(join(outDir, v.file), "utf8");
    const [chunk] = chunksOf({ repo: "main", path: v.path, text, components: ["rocketchat"] }, { enabled: false, maxTokens: 1 });
    return { v, chunk: chunk as NonNullable<typeof chunk> };
  });
  const requests = chunks.map(({ chunk }) => extractionRequest(chunk, config.name, config.llm.cloud.effort.extract));
  const answers = await client.askMany(requests);
  const rows: H3Row[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { v } = chunks[i] as (typeof chunks)[number];
    const a = answers[i] as LlmAnswer<RouteAnswer>;
    const tokens = a.usage.input > 0 ? a.usage.input + a.usage.cacheRead + a.usage.cacheWrite : counter.countTokens ? await counter.countTokens(requests[i] as never) : 0;
    const extracted = (a.parsed?.routes ?? []).filter((r) => r.kind === "http").map((r) => ({ method: r.method, template: r.name }));
    for (const route of v.routes) {
      rows.push({
        controller: v.controller,
        variant: v.id,
        series: v.series,
        level: v.level,
        model: client.model,
        tokens,
        position: route.position,
        route: `${route.method} ${route.template}`,
        found: found(route, extracted) ? 1 : 0,
        stop: a.stopReason ?? "",
      });
    }
  }
  return rows;
}

export interface ProbeRow {
  controller: string;
  model: string;
  /** `original` (the real path) or `renamed` (the path of the variants). */
  path: string;
  routes: number;
  recalled: number;
}

/**
 * Task (d): asked with the project and a path only, how many of the
 * controller's routes does the model name? With the original path that is
 * memory of the training data; with the renamed one it must be zero.
 */
export async function runProbe(outDir: string, config: TargetConfig, client: LlmClient): Promise<ProbeRow[]> {
  const manifest = loadManifest(outDir);
  const asks = manifest.controllers.flatMap((c) => [
    { c, which: "original" as const, req: probeRequest(config.name, c.source.slice(c.source.indexOf(":") + 1), config.llm.cloud.effort.probe) },
    { c, which: "renamed" as const, req: probeRequest(config.name, c.path, config.llm.cloud.effort.probe) },
  ]);
  const answers = await client.askMany(asks.map((a) => a.req));
  return asks.map(({ c, which }, i) => {
    const a = answers[i] as LlmAnswer<ProbeAnswer>;
    const named = (a.parsed?.routes ?? []).map((r) => ({ method: r.method, template: r.name }));
    const recalled = c.routes.filter((r) =>
      found({ method: r.method, template: `${r.prefix}/${which === "original" ? r.original : r.renamed}`, line: 0, position: 0 }, named),
    ).length;
    return { controller: c.id, model: client.model, path: which, routes: c.routes.length, recalled };
  });
}

export function toCsv<T extends object>(rows: T[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0] as object);
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `${[cols.join(","), ...rows.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c])).join(","))].join("\n")}\n`;
}
