import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { LikeC4 } from "likec4";

/*
 * Everything archmap takes from LikeC4 besides its language: validating a
 * workspace, the views as LikeC4 computes them, and its command-line tool.
 * The map itself is LikeC4 source text (dsl.ts, feature.ts). The version is
 * pinned in package.json, and test/map/map.test.ts checks what the map
 * relies on, so an upgrade that changes it fails the tests.
 */

export interface Diagnostic {
  message: string;
  line?: number;
  source?: string;
}

/** Diagnostics LikeC4 reports for a workspace directory: none means the map is valid. */
export async function validateWorkspace(dir: string): Promise<Diagnostic[]> {
  const likec4 = await LikeC4.fromWorkspace(dir, { printErrors: false, logger: false });
  try {
    return likec4.getErrors().map((e) => ({ message: e.message, line: e.line, source: e.sourceFsPath }));
  } finally {
    await likec4.dispose();
  }
}

/** A view as LikeC4 computes it before layout: the boxes and arrows a reader sees. */
export interface ComputedView {
  id: string;
  title: string | null;
  nodes: Array<{ id: string; color: string; shape: string }>;
  /** `relations` counts the model relations one arrow stands for. */
  edges: Array<{ source: string; target: string; label: string | null; technology: string | null; relations: number }>;
}

export async function computedViews(dir: string): Promise<ComputedView[]> {
  const likec4 = await LikeC4.fromWorkspace(dir, { printErrors: false, logger: false });
  try {
    const model = await likec4.computedModel();
    return [...model.views()].map(({ $view: v }) => ({
      id: v.id,
      title: v.title,
      nodes: v.nodes.map((n) => ({ id: n.id, color: n.color, shape: n.shape })),
      edges: v.edges.map((e) => ({ source: e.source, target: e.target, label: e.label, technology: e.technology ?? null, relations: e.relations.length })),
    }));
  } finally {
    await likec4.dispose();
  }
}

/**
 * Runs the pinned LikeC4 command-line tool, the script its package.json
 * names, with stdio shared, and resolves with its exit code. Ending archmap
 * ends it too.
 */
export function runLikec4(args: string[]): Promise<number> {
  const pkgFile = createRequire(import.meta.url).resolve("likec4/package.json");
  const { bin } = JSON.parse(readFileSync(pkgFile, "utf8")) as { bin?: string | Record<string, string> };
  const script = typeof bin === "string" ? bin : bin?.likec4;
  if (!script) throw new Error(`${pkgFile} names no likec4 command`);
  const child = spawn(process.execPath, [join(dirname(pkgFile), script), ...args], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
