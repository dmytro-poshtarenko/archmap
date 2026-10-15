/** A deployable unit described by the infrastructure: a compose service, a Kubernetes workload. */
export interface Container {
  /** Name in its description (compose service, Deployment, Terraform resource). */
  name: string;
  format: "compose" | "kubernetes" | "helm" | "terraform";
  /** `<repo>:<path>:<line>` where it is declared. */
  source: string;
  /** Component of the target config it is mapped to, if any. */
  component: string | null;
  image: string | null;
  /** Names other containers reach it by: service name, container name, aliases, Kubernetes services. */
  hostnames: string[];
  ports: number[];
  /** Environment after substitution of `${VAR:-default}` and the profile's values. */
  env: Record<string, string>;
}

/** One routing rule of a gateway: requests matching it go to a container. */
export interface GatewayRule {
  /** Component of the gateway (traefik, nginx, ingress). */
  gateway: string;
  match: "prefix" | "exact" | "regex";
  path: string;
  host: string | null;
  /** Prefix removed before forwarding. */
  strip: string | null;
  /** Prefix put in its place (nginx `proxy_pass http://x/api/`). */
  replace: string | null;
  /** Container name the requests go to. */
  target: string;
  /** Higher wins, as the gateway itself decides. */
  priority: number;
  source: string;
}

export interface InfraFacts {
  containers: Container[];
  rules: GatewayRule[];
  /** Things that could not be read, with the reason (e.g. Helm not installed). */
  warnings: string[];
}

/** Replaces `${VAR}`, `${VAR:-default}`, `${VAR-default}` and `$VAR` as docker compose does. */
export function substitute(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, braced, op, fallback, bare) => {
    if (all === "$$") return "$";
    const name = (braced ?? bare) as string;
    const value = vars[name];
    if (op === ":-") return value === undefined || value === "" ? (fallback ?? "") : value;
    if (op === "-") return value === undefined ? (fallback ?? "") : value;
    return value ?? "";
  });
}

/** Host part of a URL-like value (`mongodb://mongo:27017/db` → `mongo`), or undefined. */
export function hostOf(value: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/?#,]+)/i.exec(value.trim());
  return m?.[1];
}
