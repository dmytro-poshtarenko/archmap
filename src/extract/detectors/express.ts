import { ts } from "ts-morph";
import type { Program } from "../program.js";
import { bindingOf, resolveSymbol } from "../scope.js";
import { literalOf } from "../value.js";
import type { DetectorContext, FoundRoute, RouteDetector } from "./types.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

interface RouterObject {
  kind: "app" | "router";
  node: ts.Node;
}

interface Registration {
  router: string;
  path: string;
  method: string;
  node: ts.Node;
}

interface Mount {
  parent: string;
  prefix: string;
  child: string;
}

/**
 * Express routes, with the prefixes of the routers they are mounted on:
 * `app.use('/api', router)` and `router.get('/orders', h)` give `/api/orders`.
 * Routers are followed across modules. A router mounted nowhere keeps its own
 * paths and is marked `unmounted`.
 */
export const expressRoutes: RouteDetector = {
  kind: "routes",
  version: 1,
  run(ctx: DetectorContext): FoundRoute[] {
    const { program, evaluator } = ctx;
    const routers = new Map<string, RouterObject>();
    const registrations: Registration[] = [];
    const mounts: Mount[] = [];

    const routerOf = (expr: ts.Expression): string | undefined => {
      const e = unwrap(expr);
      if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
        const kind = factoryKind(program, e);
        if (!kind) return undefined;
        const id = program.nodeId(e);
        if (!routers.has(id)) routers.set(id, { kind, node: e });
        return id;
      }
      if (!ts.isIdentifier(e)) return undefined;
      const r = resolveSymbol(program, e);
      const t = r.target;
      if (t.kind === "binding" && t.binding.kind === "var" && t.binding.decl.initializer && !t.binding.element) {
        return routerOf(t.binding.decl.initializer);
      }
      if (t.kind === "expr") return routerOf(t.expr);
      return undefined;
    };

    for (const file of ctx.files) {
      if (!/\.(?:get|post|put|patch|delete|options|head|all|use|route)\s*\(/.test(program.text(`${file.repo}:${file.path}`))) continue;
      const sf = program.source(`${file.repo}:${file.path}`);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const method = n.expression.name.text;
          const receiver = n.expression.expression;
          if (VERBS.has(method) && n.arguments.length >= 1) {
            const chained = routeChain(receiver);
            const router = chained ? routerOf(chained.router) : n.arguments.length >= 2 ? routerOf(receiver) : undefined;
            const pathExpr = chained ? chained.path : n.arguments[0];
            const path = router && pathExpr ? literalOf(evaluator.evaluate(pathExpr)) : undefined;
            // Located at the method name, so each link of `route('/me').get(h).put(h)` keeps its own line.
            if (router && path !== undefined) {
              registrations.push({ router, path, method: method === "all" ? "*" : method.toUpperCase(), node: n.expression.name });
            }
          } else if (method === "use") {
            const parent = routerOf(receiver);
            if (parent) {
              const first = n.arguments[0];
              const prefix = first ? literalOf(evaluator.evaluate(first)) : undefined;
              const handlers = prefix !== undefined ? n.arguments.slice(1) : n.arguments;
              for (const h of handlers) {
                const child = routerOf(h);
                if (child) mounts.push({ parent, prefix: prefix ?? "", child });
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }

    // Every prefix under which each router is reachable from an app.
    const prefixes = new Map<string, Set<string>>();
    const walk = (router: string, prefix: string, seen: Set<string>) => {
      if (seen.has(router)) return;
      const set = prefixes.get(router) ?? new Set<string>();
      set.add(prefix);
      prefixes.set(router, set);
      for (const m of mounts.filter((x) => x.parent === router)) walk(m.child, joinPath(prefix, m.prefix), new Set([...seen, router]));
    };
    for (const [id, r] of routers) if (r.kind === "app") walk(id, "", new Set());

    const out: FoundRoute[] = [];
    for (const reg of registrations) {
      const known = prefixes.get(reg.router);
      const list = known ? [...known].sort() : [""];
      for (const prefix of list) {
        out.push({
          node: reg.node,
          kind: "http",
          method: reg.method,
          template: joinPath(prefix, reg.path),
          ...(known ? {} : { extra: { unmounted: true } }),
        });
      }
    }
    return out;
  },
};

/** `router.route('/me').get(h).put(h)`: the router and the path of a route chain. */
function routeChain(receiver: ts.Expression): { router: ts.Expression; path: ts.Expression | undefined } | undefined {
  let e = unwrap(receiver);
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const name = e.expression.name.text;
    if (name === "route") return { router: e.expression.expression, path: e.arguments[0] };
    if (!VERBS.has(name)) return undefined;
    e = unwrap(e.expression.expression);
  }
  return undefined;
}

/** `express()` is an app; `express.Router()` and `Router()` from express are routers. */
function factoryKind(program: Program, call: ts.CallExpression | ts.NewExpression): "app" | "router" | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    const origin = importOrigin(program, callee);
    if (origin?.module !== "express") return undefined;
    if (origin.name === "default" || origin.name === "*") return "app";
    if (origin.name === "Router") return "router";
    return undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router" && ts.isIdentifier(callee.expression)) {
    const origin = importOrigin(program, callee.expression);
    if (origin?.module === "express" && (origin.name === "default" || origin.name === "*")) return "router";
  }
  return undefined;
}

/** The module and export an identifier comes from: an import, or `const x = require('m')`. */
export function importOrigin(program: Program, id: ts.Identifier): { module: string; name: string } | undefined {
  const r = resolveSymbol(program, id);
  if (r.imports[0]) return r.imports[0];
  const b = bindingOf(id);
  if (b.kind === "var" && b.decl.initializer && ts.isCallExpression(b.decl.initializer)) {
    const call = b.decl.initializer;
    const arg = call.arguments[0];
    if (ts.isIdentifier(call.expression) && call.expression.text === "require" && arg && ts.isStringLiteral(arg)) {
      return { module: arg.text, name: "default" };
    }
  }
  return undefined;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** `/api` + `/orders/` → `/api/orders`; `/` for the root. */
export function joinPath(...parts: string[]): string {
  const joined = parts.join("/").replace(/\/{2,}/g, "/");
  const lead = joined.startsWith("/") ? joined : `/${joined}`;
  return lead.length > 1 ? lead.replace(/\/$/, "") : lead;
}

