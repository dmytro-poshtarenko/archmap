import type { CallSite, RouteDecl } from "../core/types.js";
import { httpForms, methodsOf } from "./address.js";
import { namesOf, type Resolution, type Resolver, type Sources } from "./resolve.js";

export interface Ranked {
  target: string;
  route: string | null;
  score: number;
}

interface Option {
  target: string;
  route: RouteDecl | null;
  text: string;
  method: string | null;
  component: string;
}

/**
 * Targets offered to the language model in select mode, best first: the
 * targets the rules leave open (an ambiguity) come first, then the rest by
 * score = 0.5 × Jaccard similarity of name tokens + 0.3 × (1 − normalised
 * Levenshtein distance) + 0.1 × method match + 0.1 × reachability.
 */
export function rankCandidates(resolver: Resolver, site: CallSite, resolution: Resolution, sources: Sources, limit = 5): Ranked[] {
  if (!sources.rules) return [];
  const query = queryOf(site);
  if (query === null) return [];
  const options = optionsOf(resolver, site, sources);
  const methods = site.type === "http" ? methodsOf(site.method) : null;
  const open = new Set(resolution.alternatives);
  const scored = options.map((o) => ({
    target: o.target,
    route: o.route?.id ?? null,
    open: open.has(o.target),
    score: round(
      0.5 * jaccard(tokens(query), tokens(o.text)) +
        0.3 * (1 - levenshtein(query, o.text) / Math.max(query.length, o.text.length, 1)) +
        0.1 * methodScore(methods, o.method) +
        0.1 * reachability(resolver, site, o.component, sources),
    ),
  }));
  const seen = new Set<string>();
  return scored
    .sort((a, b) => Number(b.open) - Number(a.open) || b.score - a.score || (a.target < b.target ? -1 : 1))
    .filter((c) => !seen.has(c.target) && seen.add(c.target))
    .slice(0, limit)
    .map(({ target, route, score }) => ({ target, route, score }));
}

/** The address as text: the path with `:p` for run-time segments, or the name. */
function queryOf(site: CallSite): string | null {
  if (site.type === "http") return httpForms(site.address).forms[0]?.text ?? null;
  const names = namesOf(site.address);
  if (names) return names[0] ?? null;
  return site.address.parts.map((p) => (p.k === "lit" ? p.v : "*")).join("");
}

function optionsOf(resolver: Resolver, site: CallSite, sources: Sources): Option[] {
  const each = (routes: RouteDecl[], key: (r: RouteDecl, c: string) => string): Option[] =>
    routes.flatMap((r) => r.components.map((c) => ({ target: key(r, c), route: r, text: r.kind === "http" ? resolver.patternOf(r.template).canonical : r.template, method: r.method, component: c })));
  switch (site.type) {
    case "http":
      return each(resolver.routesOf("http", sources), (r, c) => `http:${r.method?.toUpperCase() ?? "*"}:${r.template}@${c}`);
    case "ddp": {
      const verb = site.role === "subscribe" ? "sub" : "call";
      return each(
        resolver.routesOf("ddp-method", sources).filter((r) => r.method === null || r.method === verb),
        (r, c) => `ddp:${verb}:${r.template}@${c}`,
      );
    }
    case "broker":
      if (site.role === "request") return each(resolver.routesOf("broker-action", sources), (r, c) => `action:-:${r.template}@${c}`);
      return resolver.knownEvents().map((n) => ({ target: `event:-:${n}@*`, route: null, text: n, method: null, component: "*" }));
    case "db":
      return resolver.knownNames("db").flatMap((n) =>
        resolver.databases().map((db) => ({ target: `coll:-:${n}@${db}`, route: null, text: n, method: null, component: db })),
      );
    case "trigger":
      return resolver
        .knownNames("trigger")
        .flatMap((n) => site.components.map((c) => ({ target: `timer:-:${n}@${c}`, route: null, text: n, method: null, component: c })));
  }
}

function methodScore(methods: string[] | null, routeMethod: string | null): number {
  if (methods === null || routeMethod === null) return 0.5;
  return methods.includes(routeMethod.toUpperCase()) ? 1 : 0;
}

/**
 * Whether the site's part can reach the candidate's: a call into its own part
 * is no link (0); a browser client reaches what a gateway rule leads to, a
 * service what runs in a container; without infrastructure facts every
 * other part counts as reachable.
 */
function reachability(resolver: Resolver, site: CallSite, component: string, sources: Sources): number {
  if (component === "*") return 1;
  if (site.components.includes(component)) return 0;
  if (!sources.env && !sources.gateway) return 1;
  const client = site.components.some((c) => resolver.kindOf(c) === "client");
  return (client ? resolver.gatewayReaches(component) : resolver.deployed(component)) ? 1 : 0;
}

/** Name tokens: split at non-alphanumerics and camelCase humps, lower-cased, without the `p` placeholder. */
export function tokens(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t !== "" && t !== "p"),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
