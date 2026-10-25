import { ts } from "ts-morph";
import { guardOf } from "./guard.js";
import { fileId, type Program } from "./program.js";

/** Where a file runs. */
export interface FileUsage {
  components: string[];
  /**
   * For a component that reaches the file only through modules loaded under a
   * condition, those conditions (`!isRunningMs()`): the file runs there if any holds.
   */
  guards: Record<string, string[]>;
}

/** An import: the file it loads and the condition of the load, empty when there is none. */
interface Edge {
  to: string;
  guard: string;
}

/**
 * Components whose processes run each file: its own component, plus every
 * component whose code imports it, directly or not, statically or at run
 * time. A shared package (no component of its own) thus runs wherever it is
 * imported. Type-only imports do not count.
 *
 * A module loaded at run time under a condition
 * (`if (!isRunningMs()) await import('x')`) still counts, but when a
 * component reaches a file only through such loads the conditions are kept.
 * Matching then drops the component when the deployment profile makes all
 * of them false, as it does for service registrations.
 */
export function usageOfFiles(program: Program): Map<string, FileUsage> {
  const files = program.codeFiles();
  const edges = new Map<string, Edge[]>();
  const add = (from: string, to: string, guard: string) => {
    const list = edges.get(from) ?? [];
    list.push({ to, guard });
    edges.set(from, list);
  };
  for (const f of files) {
    const id = fileId(f.repo, f.path);
    const sf = program.source(id);
    for (const s of sf.statements) {
      let spec: string | undefined;
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && !s.importClause?.isTypeOnly) {
        const named = s.importClause?.namedBindings;
        const onlyTypes =
          !s.importClause?.name && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
        if (!onlyTypes) spec = s.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(s) && !s.isTypeOnly && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
        spec = s.moduleSpecifier.text;
      }
      if (!spec) continue;
      const r = program.resolveImport(id, spec);
      if (r.kind === "file") add(id, r.id, "");
    }
    // Modules loaded at run time (`await import('x')`, `require('x')`) run there too, under the `if` around the load.
    if (/\bimport\s*\(|\brequire\s*\(/.test(sf.text)) {
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
          const isLoad = n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require");
          if (isLoad) {
            const r = program.resolveImport(id, n.arguments[0].text);
            if (r.kind === "file") add(id, r.id, guardOf(n));
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }

  const roots = new Map<string, string[]>();
  for (const f of files) if (f.component) roots.set(f.component, [...(roots.get(f.component) ?? []), fileId(f.repo, f.path)]);
  const reached = new Map<string, Set<string>>();
  const guarded = new Map<string, Map<string, Set<string>>>();
  for (const [component, starts] of roots) {
    // files the component runs whatever the profile
    const always = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (always.has(id)) continue;
      always.add(id);
      for (const e of edges.get(id) ?? []) if (e.guard === "") stack.push(e.to);
    }
    // files it runs only under the conditions of the loads that lead to them
    const seen = new Set<string>();
    const pending: Array<{ id: string; guard: string }> = [];
    for (const id of always) for (const e of edges.get(id) ?? []) if (e.guard !== "") pending.push({ id: e.to, guard: e.guard });
    while (pending.length > 0) {
      const { id, guard } = pending.pop() as { id: string; guard: string };
      if (always.has(id) || seen.has(`${id}\u0000${guard}`)) continue;
      seen.add(`${id}\u0000${guard}`);
      const byComponent = guarded.get(id) ?? new Map<string, Set<string>>();
      byComponent.set(component, (byComponent.get(component) ?? new Set<string>()).add(guard));
      guarded.set(id, byComponent);
      for (const e of edges.get(id) ?? []) pending.push({ id: e.to, guard: e.guard === "" ? guard : conjoin(guard, e.guard) });
    }
    for (const id of always) reached.set(id, (reached.get(id) ?? new Set<string>()).add(component));
  }

  const out = new Map<string, FileUsage>();
  for (const id of new Set([...reached.keys(), ...guarded.keys()])) {
    const components = new Set(reached.get(id) ?? []);
    const guards: Record<string, string[]> = {};
    for (const [component, conditions] of guarded.get(id) ?? []) {
      if (components.has(component)) continue;
      components.add(component);
      guards[component] = [...conditions].sort();
    }
    out.set(id, { components: [...components].sort(), guards });
  }
  return out;
}

/** Both conditions, each part once and in a fixed order, so a cycle of imports cannot grow it. */
function conjoin(a: string, b: string): string {
  return [...new Set([...a.split(" && "), ...b.split(" && ")].filter((x) => x !== ""))].sort().join(" && ");
}

/** The components of each file, conditions aside. */
export function componentsOfFiles(program: Program): Map<string, string[]> {
  return new Map([...usageOfFiles(program)].map(([id, u]) => [id, u.components]));
}
