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

const KEY = /^(http|ddp|action|event|coll|timer):([^:@\s]+):([^@\s]+)@([a-z0-9*][a-z0-9._-]*|\*)$/;
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
