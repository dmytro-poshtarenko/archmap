import { ts } from "ts-morph";
import type { Hop } from "../core/types.js";
import type { Program } from "./program.js";

/** What an identifier refers to in the scope where it is used. */
export type Binding =
  | { kind: "var"; decl: ts.VariableDeclaration; element: ts.BindingElement | undefined; constant: boolean }
  | { kind: "function"; decl: ts.FunctionDeclaration | ts.FunctionExpression }
  | { kind: "class"; decl: ts.ClassDeclaration | ts.ClassExpression }
  | { kind: "enum"; decl: ts.EnumDeclaration }
  | { kind: "param"; decl: ts.ParameterDeclaration; fn: ts.SignatureDeclaration; index: number; element: ts.BindingElement | undefined }
  | { kind: "import"; decl: ts.ImportDeclaration | ts.ImportEqualsDeclaration; module: string; imported: string; local: ts.Identifier }
  | { kind: "global"; name: string };

/** Where a symbol leads once imports and re-exports are followed. */
export type Target =
  | { kind: "binding"; binding: Exclude<Binding, { kind: "import" | "global" }> }
  | { kind: "expr"; expr: ts.Expression }
  | { kind: "namespace"; fileId: string }
  | { kind: "external"; module: string; name: string }
  | { kind: "global"; name: string }
  | { kind: "missing" };

export interface Resolved {
  target: Target;
  hops: Hop[];
  /** Every `import { name } from module` passed through, first one first. */
  imports: Array<{ module: string; name: string }>;
}

const scopeCache = new WeakMap<ts.Node, Map<string, Binding>>();

/** The binding an identifier refers to, by walking the enclosing scopes. */
export function bindingOf(id: ts.Identifier): Binding {
  const name = id.text;
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    const found = declarationsIn(node)?.get(name);
    if (found) return found;
  }
  return { kind: "global", name };
}

function declarationsIn(node: ts.Node): Map<string, Binding> | undefined {
  let map = scopeCache.get(node);
  if (map) return map;
  map = new Map<string, Binding>();
  const add = (n: string, b: Binding) => {
    if (!map?.has(n)) map?.set(n, b);
  };
  const addVariables = (list: ts.VariableDeclarationList) => {
    const constant = (list.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of list.declarations) {
      forEachBindingName(decl.name, (nameNode, element) => add(nameNode.text, { kind: "var", decl, element, constant }));
    }
  };
  const addStatements = (statements: ts.NodeArray<ts.Statement>) => {
    for (const s of statements) {
      if (ts.isVariableStatement(s)) addVariables(s.declarationList);
      else if (ts.isFunctionDeclaration(s) && s.name) add(s.name.text, { kind: "function", decl: s });
      else if (ts.isClassDeclaration(s) && s.name) add(s.name.text, { kind: "class", decl: s });
      else if (ts.isEnumDeclaration(s)) add(s.name.text, { kind: "enum", decl: s });
      else if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) addImport(s, add);
      else if (ts.isImportEqualsDeclaration(s) && ts.isExternalModuleReference(s.moduleReference)) {
        const m = s.moduleReference.expression;
        if (ts.isStringLiteral(m)) add(s.name.text, { kind: "import", decl: s, module: m.text, imported: "*", local: s.name });
      }
    }
  };

  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) addStatements(node.statements);
  else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) addStatements(node.statements);
  else if (ts.isFunctionLike(node)) {
    node.parameters.forEach((p, index) =>
      forEachBindingName(p.name, (nameNode, element) => add(nameNode.text, { kind: "param", decl: p, fn: node, index, element })),
    );
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) {
      add(node.name.text, { kind: "function", decl: node });
    }
  } else if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) && node.initializer) {
    if (ts.isVariableDeclarationList(node.initializer)) addVariables(node.initializer);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    forEachBindingName(node.variableDeclaration.name, (n) => add(n.text, { kind: "global", name: n.text }));
  } else if (ts.isClassExpression(node) && node.name) add(node.name.text, { kind: "class", decl: node });
  else return undefined;
  scopeCache.set(node, map);
  return map;
}

function addImport(s: ts.ImportDeclaration, add: (n: string, b: Binding) => void): void {
  const module = (s.moduleSpecifier as ts.StringLiteral).text;
  const clause = s.importClause;
  // Type-only imports stay in scope: type annotations are resolved through them.
  if (!clause) return;
  if (clause.name) add(clause.name.text, { kind: "import", decl: s, module, imported: "default", local: clause.name });
  const nb = clause.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) add(nb.name.text, { kind: "import", decl: s, module, imported: "*", local: nb.name });
  if (nb && ts.isNamedImports(nb)) {
    for (const spec of nb.elements) {
      add(spec.name.text, { kind: "import", decl: s, module, imported: (spec.propertyName ?? spec.name).text, local: spec.name });
    }
  }
}

function forEachBindingName(name: ts.BindingName, fn: (id: ts.Identifier, element: ts.BindingElement | undefined) => void, element?: ts.BindingElement): void {
  if (ts.isIdentifier(name)) return fn(name, element);
  for (const e of name.elements) {
    if (ts.isBindingElement(e)) forEachBindingName(e.name, fn, e);
  }
}

/** The object property a destructuring element reads (`{ a: b }` reads `a`). */
export function elementProperty(element: ts.BindingElement): string | undefined {
  const prop = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
  if (!prop) return undefined;
  if (ts.isIdentifier(prop) || ts.isStringLiteral(prop)) return prop.text;
  return undefined;
}

/**
 * Follows an identifier through imports and re-exports to the declaration it
 * names. Imports of modules outside the snapshot end as `external`.
 */
export function resolveSymbol(program: Program, id: ts.Identifier): Resolved {
  const binding = bindingOf(id);
  if (binding.kind === "global") return { target: { kind: "global", name: binding.name }, hops: [], imports: [] };
  if (binding.kind === "var") {
    const loaded = loadedModule(binding);
    if (loaded) return resolveLoaded(program, id, binding.decl, loaded);
  }
  if (binding.kind !== "import") return { target: { kind: "binding", binding }, hops: [], imports: [] };
  const hop: Hop = { kind: "import", at: program.where(binding.decl), name: binding.local.text };
  const imports = [{ module: binding.module, name: binding.imported }];
  const r = program.resolveImport(program.idOf(id), binding.module);
  if (r.kind === "external") {
    return { target: { kind: "external", module: binding.module, name: binding.imported }, hops: [hop], imports };
  }
  if (binding.imported === "*") return { target: { kind: "namespace", fileId: r.id }, hops: [hop], imports };
  const exported = resolveExport(program, r.id, binding.imported, new Set());
  return { target: exported.target, hops: [hop, ...exported.hops], imports: [...imports, ...exported.imports] };
}

/**
 * `const { Presence } = await import('@rocket.chat/presence')` and
 * `const x = require('x')`: the module loaded at run time and the export read.
 */
function loadedModule(b: Extract<Binding, { kind: "var" }>): { module: string; name: string } | undefined {
  let init = b.decl.initializer;
  while (init && (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
  if (!init || !ts.isCallExpression(init)) return undefined;
  const isImport = init.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(init.expression) && init.expression.text === "require";
  const arg = init.arguments[0];
  if ((!isImport && !isRequire) || !arg || !ts.isStringLiteral(arg)) return undefined;
  const name = b.element ? elementProperty(b.element) : isRequire ? "default" : "*";
  return name ? { module: arg.text, name } : undefined;
}

function resolveLoaded(program: Program, id: ts.Identifier, decl: ts.Node, loaded: { module: string; name: string }): Resolved {
  const hop: Hop = { kind: "import", at: program.where(decl), name: id.text };
  const imports = [loaded];
  const r = program.resolveImport(program.idOf(id), loaded.module);
  if (r.kind === "external") return { target: { kind: "external", module: loaded.module, name: loaded.name }, hops: [hop], imports };
  if (loaded.name === "*") return { target: { kind: "namespace", fileId: r.id }, hops: [hop], imports };
  const exported = resolveExport(program, r.id, loaded.name, new Set());
  if (loaded.name === "default" && exported.target.kind === "missing") return { target: { kind: "namespace", fileId: r.id }, hops: [hop], imports };
  return { target: exported.target, hops: [hop, ...exported.hops], imports: [...imports, ...exported.imports] };
}

/** The declaration behind `name` exported by a module file. */
export function resolveExport(program: Program, fileId: string, name: string, seen: Set<string>): Resolved {
  const key = `${fileId}#${name}`;
  if (seen.has(key)) return { target: { kind: "missing" }, hops: [], imports: [] };
  seen.add(key);
  const sf = program.source(fileId);
  const local = (n: string): Resolved => {
    const b = declarationsIn(sf)?.get(n);
    if (!b) return { target: { kind: "missing" }, hops: [], imports: [] };
    if (b.kind === "import") {
      const r = program.resolveImport(fileId, b.module);
      const hop: Hop = { kind: "reexport", at: program.where(b.decl), name: n };
      if (r.kind === "external") return { target: { kind: "external", module: b.module, name: b.imported }, hops: [hop], imports: [{ module: b.module, name: b.imported }] };
      if (b.imported === "*") return { target: { kind: "namespace", fileId: r.id }, hops: [hop], imports: [] };
      const inner = resolveExport(program, r.id, b.imported, seen);
      return { target: inner.target, hops: [hop, ...inner.hops], imports: [{ module: b.module, name: b.imported }, ...inner.imports] };
    }
    if (b.kind === "global") return { target: { kind: "missing" }, hops: [], imports: [] };
    return { target: { kind: "binding", binding: b }, hops: [], imports: [] };
  };

  const stars: string[] = [];
  for (const s of sf.statements) {
    const exported = ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported && ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return local(name);
      }
    }
    if (exported && (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s))) {
      if (isDefault && name === "default") {
        if (ts.isFunctionDeclaration(s)) return { target: { kind: "binding", binding: { kind: "function", decl: s } }, hops: [], imports: [] };
        if (ts.isClassDeclaration(s)) return { target: { kind: "binding", binding: { kind: "class", decl: s } }, hops: [], imports: [] };
      }
      if (s.name?.text === name) return local(name);
    }
    if (ts.isExportAssignment(s) && !s.isExportEquals && name === "default") {
      if (ts.isIdentifier(s.expression)) return local(s.expression.text);
      return { target: { kind: "expr", expr: s.expression }, hops: [], imports: [] };
    }
    if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      const from = s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : undefined;
      const clause = s.exportClause;
      if (!clause && from) {
        stars.push(from);
        continue;
      }
      if (clause && ts.isNamespaceExport(clause) && clause.name.text === name && from) {
        const r = program.resolveImport(fileId, from);
        if (r.kind === "file") return { target: { kind: "namespace", fileId: r.id }, hops: [], imports: [] };
        return { target: { kind: "external", module: from, name: "*" }, hops: [], imports: [{ module: from, name: "*" }] };
      }
      if (clause && ts.isNamedExports(clause)) {
        for (const spec of clause.elements) {
          if (spec.isTypeOnly || spec.name.text !== name) continue;
          const original = (spec.propertyName ?? spec.name).text;
          if (!from) return local(original);
          const hop: Hop = { kind: "reexport", at: program.where(s), name };
          const r = program.resolveImport(fileId, from);
          if (r.kind === "external") return { target: { kind: "external", module: from, name: original }, hops: [hop], imports: [{ module: from, name: original }] };
          const inner = resolveExport(program, r.id, original, seen);
          return { target: inner.target, hops: [hop, ...inner.hops], imports: [{ module: from, name: original }, ...inner.imports] };
        }
      }
    }
    // CommonJS: exports.X = ..., module.exports.X = ..., module.exports = { X }
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = s.expression.left.getText(sf);
      const right = s.expression.right;
      if (left === `exports.${name}` || left === `module.exports.${name}`) return { target: { kind: "expr", expr: right }, hops: [], imports: [] };
      if (left === "module.exports" && name === "default") return { target: { kind: "expr", expr: right }, hops: [], imports: [] };
      if (left === "module.exports" && ts.isObjectLiteralExpression(right)) {
        for (const p of right.properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText(sf) === name) return { target: { kind: "expr", expr: p.initializer }, hops: [], imports: [] };
          if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return local(name);
        }
      }
    }
  }
  if (name !== "default") {
    for (const from of stars) {
      const r = program.resolveImport(fileId, from);
      if (r.kind !== "file") continue;
      const inner = resolveExport(program, r.id, name, seen);
      if (inner.target.kind !== "missing") return { ...inner, hops: [{ kind: "reexport", at: `${fileId}:1`, name }, ...inner.hops] };
    }
  }
  return { target: { kind: "missing" }, hops: [], imports: [] };
}

/** The innermost function-like node containing a node. */
export function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && !ts.isFunctionTypeNode(n) && !ts.isConstructorTypeNode(n) && !ts.isMethodSignature(n)) return n;
  }
  return undefined;
}

/**
 * Whether a `let` or `var` is ever assigned after its declaration; if not,
 * its initializer is as good as a constant.
 */
export function isReassigned(decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return true;
  const name = decl.name.text;
  let container: ts.Node = decl;
  while (container.parent && !ts.isSourceFile(container) && !ts.isFunctionLike(container)) container = container.parent;
  let assigned = false;
  const visit = (n: ts.Node) => {
    if (assigned) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (ts.isIdentifier(n.left) && n.left.text === name) {
        const b = bindingOf(n.left);
        if (b.kind === "var" && b.decl === decl) assigned = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(container);
  return assigned;
}
