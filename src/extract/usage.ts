import { ts } from "ts-morph";
import { fileId, type Program } from "./program.js";

/**
 * Components whose processes run each file: its own component, plus every
 * component whose code imports it, directly or not, statically or at run time.
 * A shared package (no component of its own) thus runs wherever it is
 * imported. Type-only imports do not count. A module loaded only under a
 * condition (a deployment profile) is still counted; which registrations a
 * profile activates is decided when matching.
 */
export function componentsOfFiles(program: Program): Map<string, string[]> {
  const files = program.codeFiles();
  const edges = new Map<string, Set<string>>();
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
      if (r.kind !== "file") continue;
      const set = edges.get(id) ?? new Set<string>();
      set.add(r.id);
      edges.set(id, set);
    }
    // Modules loaded at run time (`await import('x')`, `require('x')`) run there too.
    if (/\bimport\s*\(|\brequire\s*\(/.test(sf.text)) {
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
          const isLoad = n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require");
          if (isLoad) {
            const r = program.resolveImport(id, n.arguments[0].text);
            if (r.kind === "file") {
              const set = edges.get(id) ?? new Set<string>();
              set.add(r.id);
              edges.set(id, set);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  const result = new Map<string, Set<string>>();
  for (const f of files) {
    if (!f.component) continue;
    const start = fileId(f.repo, f.path);
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      const set = result.get(id) ?? new Set<string>();
      if (set.has(f.component)) continue;
      set.add(f.component);
      result.set(id, set);
      for (const next of edges.get(id) ?? []) stack.push(next);
    }
  }
  return new Map([...result.entries()].map(([id, set]) => [id, [...set].sort()]));
}
