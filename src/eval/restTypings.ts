import { ts } from "ts-morph";
import type { RouteDecl } from "../core/types.js";
import type { Program } from "../extract/program.js";

const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface TypedRoute {
  method: string;
  /** Served path, `/api` + the typed path. */
  path: string;
  at: string;
}

/**
 * The typed REST catalog of Rocket.Chat (`@rocket.chat/rest-typings`): every
 * object type member named by a path (`'/v1/rooms.info': { GET: ... }`) with
 * HTTP method members. It is part of the reference, never of the method.
 */
export function typedRoutes(program: Program, repo: string, root = "packages/rest-typings/src/"): TypedRoute[] {
  const out: TypedRoute[] = [];
  for (const f of program.codeFiles()) {
    if (f.repo !== repo || !f.path.startsWith(root)) continue;
    const id = `${f.repo}:${f.path}`;
    const visit = (n: ts.Node) => {
      if ((ts.isPropertySignature(n) || ts.isPropertyAssignment(n)) && ts.isStringLiteral(n.name) && n.name.text.startsWith("/")) {
        const type = ts.isPropertySignature(n) ? n.type : undefined;
        if (type && ts.isTypeLiteralNode(type)) {
          for (const m of type.members) {
            const name = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : undefined;
            if (name && VERBS.has(name)) out.push({ method: name, path: `/api${n.name.text}`, at: program.where(m) });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(program.source(id));
  }
  return out;
}

/** Path parameters compare by position, not by name. */
export function canonicalRoute(method: string, path: string): string {
  return `${method} ${path.replace(/\/:[A-Za-z_]\w*/g, "/:p").replace(/\/+$/, "")}`;
}

export interface RouteComparison {
  typed: number;
  extracted: number;
  found: number;
  recall: number;
  missing: TypedRoute[];
  untyped: RouteDecl[];
}

/** A route template as a pattern over paths: `:param` matches one segment. */
function pattern(template: string): RegExp {
  const body = template
    .replace(/\/+$/, "")
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}/?$`);
}

/**
 * How many typed routes the extraction rules found, and the differences both
 * ways. A typed path counts as found when an extracted route of the same
 * method serves it, by name or as a template (`/livechat/users/:type` serves
 * `/livechat/users/agent`).
 */
export function compareRoutes(typed: TypedRoute[], routes: RouteDecl[]): RouteComparison {
  const http = routes.filter((r) => r.kind === "http" && r.method !== null);
  const verbsOf = (r: RouteDecl) => (r.method === "*" ? [...VERBS] : [r.method ?? ""]);
  const extractedKeys = new Set(http.flatMap((r) => verbsOf(r).map((v) => canonicalRoute(v, r.template))));
  const patterns = http.flatMap((r) => verbsOf(r).map((v) => ({ method: v, re: pattern(r.template), route: r })));
  const typedKeys = new Map<string, TypedRoute>();
  for (const t of typed) typedKeys.set(canonicalRoute(t.method, t.path), t);
  const serves = (t: TypedRoute) => patterns.some((p) => p.method === t.method && p.re.test(t.path.replace(/\/:[A-Za-z_]\w*/g, "/x")));
  const missing = [...typedKeys.entries()].filter(([k, t]) => !extractedKeys.has(k) && !serves(t)).map(([, t]) => t);
  const untyped = http.filter((r) => {
    const re = pattern(r.template);
    return !verbsOf(r).some((v) => typedKeys.has(canonicalRoute(v, r.template)) || typed.some((t) => t.method === v && re.test(t.path.replace(/\/:[A-Za-z_]\w*/g, "/x"))));
  });
  const found = typedKeys.size - missing.length;
  return { typed: typedKeys.size, extracted: extractedKeys.size, found, recall: typedKeys.size === 0 ? 0 : found / typedKeys.size, missing, untyped };
}
