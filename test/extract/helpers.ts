import { posix } from "node:path";
import { ts } from "ts-morph";
import { CallMatcher } from "../../src/extract/calls.js";
import { Evaluator, type ValueSource } from "../../src/extract/evaluate.js";
import { Lifter } from "../../src/extract/lift.js";
import { fileId, Program } from "../../src/extract/program.js";
import { loadRules } from "../../src/extract/rules.js";

const LANGS: Record<string, string> = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".json": "json" };

/** A program over in-memory files keyed '<repo>:<path>'. */
export function programFrom(files: Record<string, string>, components: Record<string, string> = {}): Program {
  const list = Object.keys(files)
    .sort()
    .map((key) => {
      const at = key.indexOf(":");
      const path = key.slice(at + 1);
      return { repo: key.slice(0, at), path, lang: LANGS[posix.extname(path)] ?? null, component: components[key] ?? null };
    });
  return new Program(list, (repo, path) => {
    const text = files[`${repo}:${path}`];
    if (text === undefined) throw new Error(`no file ${repo}:${path}`);
    return text;
  });
}

export function evaluatorOf(program: Program, valueSources: ValueSource[] = []): Evaluator {
  return new Evaluator(program, { maxDepth: 8, valueSources });
}

/** The initializer of `const probe = …` in a file. */
export function probe(program: Program, id: string): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "probe" && n.initializer) found = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(program.source(id));
  if (!found) throw new Error(`no probe in ${id}`);
  return found;
}

/** Sites of the generic pack, lifted, as `<file>:<line> <method> <display>`. */
export function sitesOf(program: Program, liftDepth = 3, refs = ["generic@1", "meteor@1"]) {
  const rules = loadRules(refs);
  const evaluator = evaluatorOf(program, rules.valueSources);
  const matcher = new CallMatcher(program, evaluator, rules);
  const files = program.codeFiles().map((f) => fileId(f.repo, f.path));
  const lifter = new Lifter(program, matcher, evaluator, { maxDepth: liftDepth, files });
  return matcher.detect(files).flatMap((r) => lifter.place(r));
}
