import { load as parseYaml } from "js-yaml";
import { type Container, type GatewayRule, substitute } from "./model.js";
import { traefikMiddlewares, traefikRules } from "./traefik.js";

type Doc = { services?: Record<string, Record<string, unknown>> };

/**
 * A docker compose file: one container per service, its environment after
 * `${VAR:-default}` substitution (profile values first, then `.env`), the
 * names it is reachable by, and the Traefik routing rules in its labels.
 */
export function parseCompose(
  text: string,
  file: string,
  vars: Record<string, string>,
): { containers: Container[]; rules: GatewayRule[] } {
  const doc = (parseYaml(text) ?? {}) as Doc;
  const services = doc.services ?? {};
  const lines = text.split("\n");
  const lineOf = (name: string) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(l));
    return i === -1 ? 1 : i + 1;
  };
  const sub = (v: unknown) => substitute(String(v), vars);
  const containers: Container[] = [];
  const labelsOf = new Map<string, Record<string, string>>();
  for (const [name, svc] of Object.entries(services)) {
    const env: Record<string, string> = {};
    const environment = svc.environment;
    if (Array.isArray(environment)) {
      for (const item of environment) {
        const s = String(item);
        const at = s.indexOf("=");
        if (at > 0) env[s.slice(0, at)] = sub(s.slice(at + 1));
      }
    } else if (environment && typeof environment === "object") {
      for (const [k, v] of Object.entries(environment as Record<string, unknown>)) env[k] = v === null ? "" : sub(v);
    }
    const labels: Record<string, string> = {};
    if (Array.isArray(svc.labels)) {
      for (const item of svc.labels) {
        const s = String(item);
        const at = s.indexOf("=");
        if (at > 0) labels[s.slice(0, at)] = sub(s.slice(at + 1));
      }
    } else if (svc.labels && typeof svc.labels === "object") {
      for (const [k, v] of Object.entries(svc.labels as Record<string, unknown>)) labels[k] = sub(v);
    }
    labelsOf.set(name, labels);
    const hostnames = new Set<string>([name]);
    if (typeof svc.container_name === "string") hostnames.add(sub(svc.container_name));
    if (typeof svc.hostname === "string") hostnames.add(sub(svc.hostname));
    const networks = svc.networks;
    if (networks && typeof networks === "object" && !Array.isArray(networks)) {
      for (const n of Object.values(networks as Record<string, unknown>)) {
        const aliases = (n as { aliases?: unknown } | null)?.aliases;
        if (Array.isArray(aliases)) for (const a of aliases) hostnames.add(sub(a));
      }
    }
    const ports = new Set<number>();
    for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
      const target = /(\d+)(?:\/\w+)?$/.exec(typeof p === "object" && p !== null ? String((p as { target?: unknown }).target ?? "") : sub(p))?.[1];
      if (target) ports.add(Number(target));
    }
    for (const [k, v] of Object.entries(labels)) if (/\.loadbalancer\.server\.port$/.test(k)) ports.add(Number(v));
    containers.push({
      name,
      format: "compose",
      source: `${file}:${lineOf(name)}`,
      component: null,
      image: svc.image === undefined ? null : sub(svc.image),
      hostnames: [...hostnames],
      ports: [...ports].sort((a, b) => a - b),
      env,
    });
  }
  // Traefik reads the labels of every service; the gateway is the service running the traefik image.
  const gateway = containers.find((c) => /(^|\/)traefik(:|$)/.test(c.image ?? ""))?.name;
  const rules: GatewayRule[] = [];
  if (gateway) {
    const middlewares = new Map<string, { strip: string[]; add: string | null }>();
    for (const labels of labelsOf.values()) for (const [k, v] of traefikMiddlewares(labels)) middlewares.set(k, v);
    for (const [name, labels] of labelsOf) {
      if (labels["traefik.enable"] === "false") continue;
      rules.push(...traefikRules(name, labels, middlewares, gateway, `${file}:${lineOf(name)}`));
    }
  }
  return { containers, rules };
}

/** `KEY=VALUE` lines of a `.env` file. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
