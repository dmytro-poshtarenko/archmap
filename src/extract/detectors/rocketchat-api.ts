import { ts } from "ts-morph";
import type { Evaluator } from "../evaluate.js";
import type { Program } from "../program.js";
import { bindingOf, elementProperty, resolveSymbol } from "../scope.js";
import { literalOf } from "../value.js";
import { joinPath } from "./express.js";
import type { DetectorContext, FoundRoute, RouteDetector } from "./types.js";

const PREFIXES: Record<string, string> = { v1: "/api/v1", experimental: "/api/experimental", default: "/api" };
const VERBS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Routes of the Rocket.Chat REST router: `API.v1.addRoute('rooms.info', options,
 * { get() {}, post() {} })` and the validated form `API.v1.get('rooms.info',
 * options, action)`, also chained (`API.v1.get(...).post(...)`). The name is
 * served under `/api/v1/`, `/api/experimental/` or `/api/`.
 */
export const rocketchatApi: RouteDetector = {
  kind: "routes",
  version: 3,
  run(ctx: DetectorContext): FoundRoute[] {
    const { program, evaluator } = ctx;
    const out: FoundRoute[] = [];
    for (const f of ctx.files) {
      const id = `${f.repo}:${f.path}`;
      if (!/\.\s*(?:addRoute|get|post|put|delete)\s*\(/.test(program.text(id))) continue;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const member = n.expression.name.text;
          const prefix = member === "addRoute" || VERBS.has(member) ? apiPrefix(program, evaluator, n.expression.expression) : undefined;
          if (prefix !== undefined) {
            const names = routeNames(evaluator, n.arguments[0]);
            const verbs = member === "addRoute" ? handlerVerbs(program, n.arguments[n.arguments.length - 1]) : [member.toUpperCase()];
            for (const name of names) {
              for (const verb of verbs.length > 0 ? verbs : ["*"]) {
                out.push({ node: n.expression.name, kind: "http", method: verb, template: joinPath(prefix, name) });
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(program.source(id));
    }
    return out;
  },
};

/**
 * The path prefix of the router a route is declared on: `API.v1`, or any
 * other instance of `APIClass` (`new WebHookAPI({ apiPath: 'hooks/' })`,
 * `this.api = new API.ApiClass({ version: 'apps' })`), also through a chain
 * of route declarations on it.
 */
function apiPrefix(program: Program, evaluator: Evaluator, receiver: ts.Expression): string | undefined {
  let e = receiver;
  for (;;) {
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "API") {
      return PREFIXES[e.name.text];
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (m !== "addRoute" && !VERBS.has(m)) return undefined;
      e = e.expression.expression;
      continue;
    }
    const created = instanceCreation(program, e);
    return created && isApiClass(program, created.expression) ? prefixOf(evaluator, created) : undefined;
  }
}

/**
 * The `new X(...)` an expression holds: a constant, `this.prop` assigned in
 * the class, or a parameter whose type annotation names a class
 * (`({ api }: AppsRestApi) => api.get(...)` reads `AppsRestApi`'s `this.api`).
 */
function instanceCreation(program: Program, e: ts.Expression): ts.NewExpression | undefined {
  if (ts.isIdentifier(e)) {
    const b = bindingOf(e);
    if (b.kind === "param") {
      const type = b.decl.type;
      if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
      const r = resolveSymbol(program, type.typeName);
      const cls = r.target.kind === "binding" && r.target.binding.kind === "class" ? r.target.binding.decl : undefined;
      const prop = b.element ? elementProperty(b.element) : undefined;
      return cls && prop ? assignedInClass(cls, prop) : undefined;
    }
    const r = resolveSymbol(program, e);
    const t = r.target;
    if (t.kind === "binding" && t.binding.kind === "var" && t.binding.decl.initializer && ts.isNewExpression(t.binding.decl.initializer)) {
      return t.binding.decl.initializer;
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) {
    let cls: ts.Node | undefined = e.parent;
    while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
    return cls ? assignedInClass(cls, e.name.text) : undefined;
  }
  return undefined;
}

/** `this.<prop> = new X(...)` anywhere in a class. */
function assignedInClass(cls: ts.Node, prop: string): ts.NewExpression | undefined {
  let found: ts.NewExpression | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      n.left.name.text === prop &&
      ts.isNewExpression(n.right)
    ) {
      found = n.right;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(cls);
  return found;
}

/** `APIClass`, `API.ApiClass`, or a class extending one of them. */
function isApiClass(program: Program, callee: ts.Expression, depth = 0): boolean {
  if (depth > 4) return false;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  if (name === "APIClass" || name === "ApiClass") return true;
  if (!ts.isIdentifier(callee)) return false;
  const r = resolveSymbol(program, callee);
  if (r.target.kind !== "binding" || r.target.binding.kind !== "class") return false;
  const base = r.target.binding.decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  return base !== undefined && isApiClass(program, base, depth + 1);
}

/** `/api` + `apiPath` + `version` of an API class's options. */
function prefixOf(evaluator: Evaluator, created: ts.NewExpression): string | undefined {
  const options = created.arguments?.[0];
  if (!options) return "/api";
  const apiPath = evaluator.property(options, ["apiPath"]);
  const version = evaluator.property(options, ["version"]);
  const a = apiPath ? literalOf(apiPath) : "";
  const v = version ? literalOf(version) : "";
  if (a === undefined || v === undefined) return undefined;
  return joinPath("/api", a, v);
}

function routeNames(evaluator: DetectorContext["evaluator"], arg: ts.Expression | undefined): string[] {
  if (!arg) return [];
  let e = arg;
  if (ts.isIdentifier(e)) {
    const b = bindingOf(e);
    if (b.kind === "var" && b.decl.initializer) e = b.decl.initializer;
  }
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.flatMap((x) => {
      const t = literalOf(evaluator.evaluate(x));
      return t === undefined ? [] : [t];
    });
  }
  const t = literalOf(evaluator.evaluate(e));
  return t === undefined ? [] : [t];
}

/** HTTP methods an `addRoute` handlers object implements (`get() {}`, `post: {...}`). */
function handlerVerbs(program: DetectorContext["program"], arg: ts.Expression | undefined): string[] {
  if (!arg) return [];
  let e = arg;
  if (ts.isIdentifier(e)) {
    const r = resolveSymbol(program, e);
    if (r.target.kind === "binding" && r.target.binding.kind === "var" && r.target.binding.decl.initializer) e = r.target.binding.decl.initializer;
  }
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  if (!ts.isObjectLiteralExpression(e)) return [];
  const verbs: string[] = [];
  for (const p of e.properties) {
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
    if (name && VERBS.has(name)) verbs.push(name.toUpperCase());
  }
  return verbs;
}
