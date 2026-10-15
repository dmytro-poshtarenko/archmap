import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { globSync } from "tinyglobby";
import { describe, expect, it } from "vitest";
import { toolRoot } from "../src/core/paths.js";

/**
 * The method must not see the reference labels: modules that recover the map
 * never import the labelling or evaluation code, directly or through each
 * other. (TypeScript 7 has no JS compiler API, so dependency-cruiser cannot
 * parse the sources; the rule is checked here instead.)
 */
const METHOD = ["core", "config", "store", "workspace", "extract", "infra", "classify", "match", "llm", "map", "mcp"];
const REFERENCE = ["labelling", "eval"];

const SPECIFIER = /(?:^|\s)(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gm;

function moduleOf(file: string): string | undefined {
  return relative(join(toolRoot, "src"), file).split("/")[0];
}

function localImports(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec?.startsWith(".")) out.push(resolve(dirname(file), spec).replace(/\.js$/, ".ts"));
  }
  return out;
}

describe("architecture", () => {
  it("keeps the method independent of the reference labels", () => {
    const files = globSync(["src/**/*.ts"], { cwd: toolRoot, absolute: true });
    const graph = new Map(files.map((f) => [f, localImports(f)]));
    const violations: string[] = [];
    for (const start of files.filter((f) => METHOD.includes(moduleOf(f) ?? ""))) {
      const seen = new Set<string>([start]);
      const stack = [start];
      while (stack.length > 0) {
        const file = stack.pop() as string;
        for (const dep of graph.get(file) ?? []) {
          if (REFERENCE.includes(moduleOf(dep) ?? "")) violations.push(`${relative(toolRoot, start)} -> ${relative(toolRoot, dep)}`);
          if (!seen.has(dep)) {
            seen.add(dep);
            stack.push(dep);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("recognises the import forms it checks", () => {
    const sample = `import a from "./a.js";\nimport { b } from '../b.js';\nexport * from "./c.js";\nimport "./d.js";\nconst e = await import("./e.js");\n`;
    const specs = [...sample.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3]);
    expect(specs).toEqual(["./a.js", "../b.js", "./c.js", "./d.js", "./e.js"]);
  });
});
