import type { GatewayRule } from "./model.js";

export interface TraefikMatcher {
  match: "prefix" | "exact" | "regex";
  path: string;
  host: string | null;
}

/**
 * Traefik router rules: `PathPrefix(`/a`) || PathPrefix(`/b`)`, `Path(`/x`)`,
 * `PathRegexp(`^/x`)`, combined with `Host(`h`)` by `&&` and `||`, with
 * parentheses. The expression is expanded into alternatives, each one matcher;
 * an alternative without a path matches every path.
 */
export function parseTraefikRule(rule: string): TraefikMatcher[] {
  const tokens = rule.match(/\|\||&&|\(|\)|!?[A-Za-z]+\s*\((?:[^()`]|`[^`]*`)*\)/g) ?? [];
  let pos = 0;
  type Atom = { fn: string; args: string[] };
  // Disjunctive normal form: a list of conjunctions of atoms.
  const expr = (): Atom[][] => {
    let out = term();
    while (tokens[pos] === "||") {
      pos++;
      out = [...out, ...term()];
    }
    return out;
  };
  const term = (): Atom[][] => {
    let out = factor();
    while (tokens[pos] === "&&") {
      pos++;
      const right = factor();
      out = out.flatMap((a) => right.map((b) => [...a, ...b]));
    }
    return out;
  };
  const factor = (): Atom[][] => {
    const tok = tokens[pos++];
    if (tok === "(") {
      const inner = expr();
      if (tokens[pos] === ")") pos++;
      return inner;
    }
    const m = /^(!?[A-Za-z]+)\s*\((.*)\)$/s.exec(tok ?? "");
    if (!m) return [[]];
    return [[{ fn: m[1] as string, args: [...(m[2] ?? "").matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)].map((a) => a[1] ?? a[2] ?? a[3] ?? "") }]];
  };
  const out: TraefikMatcher[] = [];
  for (const conjunction of expr()) {
    let host: string | null = null;
    const paths: Array<{ match: TraefikMatcher["match"]; path: string }> = [];
    for (const atom of conjunction) {
      if (atom.fn === "Host") host = atom.args[0] ?? null;
      else if (atom.fn === "PathPrefix") for (const a of atom.args) paths.push({ match: "prefix", path: a });
      else if (atom.fn === "Path") for (const a of atom.args) paths.push({ match: "exact", path: a });
      else if (atom.fn === "PathRegexp") for (const a of atom.args) paths.push({ match: "regex", path: a });
    }
    if (paths.length === 0) paths.push({ match: "prefix", path: "/" });
    for (const p of paths) out.push({ ...p, host });
  }
  return out;
}

interface Router {
  rule?: string;
  service?: string;
  priority?: number;
  middlewares: string[];
}

/**
 * Gateway rules from the Traefik labels of one compose service. Routers
 * without an explicit service go to the service declaring them; priority is
 * Traefik's default, the length of the rule, unless set.
 */
export function traefikRules(
  container: string,
  labels: Record<string, string>,
  middlewares: Map<string, { strip: string[]; add: string | null }>,
  gateway: string,
  source: string,
): GatewayRule[] {
  const routers = new Map<string, Router>();
  for (const [key, value] of Object.entries(labels)) {
    const m = /^traefik\.http\.routers\.([^.]+)\.(rule|service|priority|middlewares)$/.exec(key);
    if (!m) continue;
    const r = routers.get(m[1] as string) ?? { middlewares: [] };
    if (m[2] === "rule") r.rule = value;
    if (m[2] === "service") r.service = value;
    if (m[2] === "priority") r.priority = Number(value);
    if (m[2] === "middlewares") r.middlewares = value.split(",").map((x) => x.trim().replace(/@.*$/, ""));
    routers.set(m[1] as string, r);
  }
  const out: GatewayRule[] = [];
  for (const r of routers.values()) {
    if (!r.rule) continue;
    let strip: string | null = null;
    let replace: string | null = null;
    for (const name of r.middlewares) {
      const mw = middlewares.get(name);
      if (mw?.strip[0]) strip = mw.strip[0];
      if (mw?.add) replace = mw.add;
    }
    for (const matcher of parseTraefikRule(r.rule)) {
      out.push({
        gateway,
        ...matcher,
        strip,
        replace,
        target: container,
        priority: r.priority ?? r.rule.length,
        source,
      });
    }
  }
  return out;
}

/** Middlewares declared by labels: strip and add prefixes. */
export function traefikMiddlewares(labels: Record<string, string>): Map<string, { strip: string[]; add: string | null }> {
  const out = new Map<string, { strip: string[]; add: string | null }>();
  for (const [key, value] of Object.entries(labels)) {
    const m = /^traefik\.http\.middlewares\.([^.]+)\.(stripprefix\.prefixes|addprefix\.prefix)$/.exec(key);
    if (!m) continue;
    const mw = out.get(m[1] as string) ?? { strip: [], add: null };
    if (m[2] === "stripprefix.prefixes") mw.strip = value.split(",").map((x) => x.trim());
    else mw.add = value;
    out.set(m[1] as string, mw);
  }
  return out;
}
