/**
 * Target keys `kind:method:name@component`: the one form shared by the
 * reference labels, the links of the method and the normalised answers of the
 * language model, so evaluation compares strings.
 */

/** Kinds of target in a target key. */
export const TARGET_KINDS = ["http", "ddp", "action", "event", "coll", "timer"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface TargetKey {
  kind: TargetKind;
  method: string;
  name: string;
  component: string;
}

/** The name may hold single spaces between words: job names are free text, as in `timer:-:Cleanup OEmbed cache@rocketchat`. */
const KEY = /^(http|ddp|action|event|coll|timer):([^:@\s]+):([^@\s]+(?: [^@\s]+)*)@([a-z0-9*][a-z0-9._-]*|\*)$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "*"]);

/**
 * Parses and checks a target key against the grammar of the labelling guide:
 * `http:<VERB>:<route>@c`, `ddp:call|sub:<name>@c`, `action:-:<service>.<action>@c`,
 * `event:-:<name>@*`, `coll:-:<collection>@c`, `timer:-:<job>@c`.
 */
export function parseTargetKey(key: string): TargetKey | { error: string } {
  const m = KEY.exec(key);
  if (!m) return { error: "expected kind:method:name@component" };
  const [, kind, method, name, component] = m as unknown as [string, TargetKind, string, string, string];
  if (kind === "http" && !HTTP_METHODS.has(method)) return { error: "http method must be GET, POST, PUT, PATCH, DELETE or *" };
  if (kind === "http" && !name.startsWith("/")) return { error: "http route must start with /" };
  if (kind === "ddp" && method !== "call" && method !== "sub") return { error: "ddp method must be call or sub" };
  if (kind !== "http" && kind !== "ddp" && method !== "-") return { error: `${kind} keys use '-' as method` };
  if (kind === "action" && !name.includes(".")) return { error: "action name must be <service>.<action>" };
  if (kind === "event" && component !== "*") return { error: "event keys use '*' as component" };
  if (kind !== "event" && component === "*") return { error: "only event keys use '*' as component" };
  return { kind, method, name, component };
}

export function formatTargetKey(k: TargetKey): string {
  return `${k.kind}:${k.method}:${k.name}@${k.component}`;
}

/**
 * Form in which keys are compared: path parameter names do not matter, so
 * `/livechat/agents/:uid/departments` and `/livechat/agents/:agentId/departments`
 * are the same route.
 */
export function canonicalTargetKey(key: string): string {
  if (!key.startsWith("http:")) return key;
  return key.replace(/\/:[A-Za-z_][\w]*/g, "/:p");
}

/** A route path without host, query and router prefixes, parameters by position: `/api/v1/rooms/:id` → `rooms/:p`. */
export function barePath(path: string): string {
  return path
    .replace(/^[a-z]+:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/^(?:api\/)?(?:v\d+\/|experimental\/)?/, "")
    .replace(/\/:[A-Za-z_]\w*/g, "/:p")
    .replace(/\/\$\{[^}]*\}/g, "/:p")
    .replace(/\/+$/, "");
}

/**
 * Whether two target keys name the same target when only paths and names
 * count: the part of the system is ignored, HTTP paths lose their router
 * prefixes, and a method of `*` matches any. Used to compare with tools
 * that cannot name the part, such as the baseline.
 */
export function samePath(a: string, b: string): boolean {
  const pa = parseTargetKey(a);
  const pb = parseTargetKey(b);
  const split = (k: string) => {
    const kind = k.slice(0, k.indexOf(":"));
    const rest = k.slice(kind.length + 1);
    const method = rest.slice(0, rest.indexOf(":"));
    const name = rest.slice(method.length + 1, rest.lastIndexOf("@"));
    return { kind, method, name };
  };
  const x = "error" in pa ? split(a) : pa;
  const y = "error" in pb ? split(b) : pb;
  if (x.kind !== y.kind) return false;
  if (x.kind === "http") return (x.method === y.method || x.method === "*" || y.method === "*") && barePath(x.name) === barePath(y.name);
  return x.method === y.method && x.name === y.name;
}
