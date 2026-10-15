import hcl from "hcl2-json-parser";
import type { Container, GatewayRule } from "./model.js";
import { fromManifests } from "./kubernetes.js";

type Obj = Record<string, any>;

/**
 * Terraform: variables (their defaults) and locals are substituted into
 * strings, then the Kubernetes and Docker resources are read like their
 * manifests: `kubernetes_deployment`, `kubernetes_service`,
 * `kubernetes_ingress_v1`, `kubernetes_config_map` and `docker_container`.
 */
export async function fromTerraform(texts: Array<{ text: string; file: string }>, gateway: string): Promise<{ containers: Container[]; rules: GatewayRule[]; warnings: string[] }> {
  const vars: Record<string, unknown> = {};
  const locals: Record<string, unknown> = {};
  const resources: Array<{ type: string; name: string; body: Obj; source: string }> = [];
  const warnings: string[] = [];
  for (const { text, file } of texts) {
    let doc: Obj;
    try {
      doc = (await hcl.parseToObject(text)) as Obj;
    } catch (error) {
      warnings.push(`${file}: ${String((error as Error)?.message ?? error ?? "parse error")}`);
      continue;
    }
    for (const [name, defs] of Object.entries((doc.variable ?? {}) as Obj)) vars[name] = (defs as Obj[])[0]?.default;
    for (const block of (doc.locals ?? []) as Obj[]) Object.assign(locals, block);
    for (const [type, byName] of Object.entries((doc.resource ?? {}) as Obj)) {
      for (const [name, bodies] of Object.entries(byName as Obj)) {
        const line = text.split("\n").findIndex((l) => l.includes(`"${type}"`) && l.includes(`"${name}"`)) + 1;
        resources.push({ type, name, body: (bodies as Obj[])[0] ?? {}, source: `${file}:${line || 1}` });
      }
    }
  }
  const resolve = (v: unknown, depth = 0): unknown => {
    if (depth > 8) return v;
    if (typeof v === "string") {
      const whole = /^\$\{(var|local)\.([\w-]+)\}$/.exec(v);
      if (whole) return resolve((whole[1] === "var" ? vars : locals)[whole[2] as string], depth + 1);
      return v.replace(/\$\{(var|local)\.([\w-]+)\}/g, (all, kind: string, name: string) => {
        const r = resolve((kind === "var" ? vars : locals)[name], depth + 1);
        return typeof r === "string" || typeof r === "number" ? String(r) : all;
      });
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, depth)]));
    return v;
  };
  const one = (x: unknown) => (Array.isArray(x) ? x[0] : x) as Obj | undefined;
  const docs: Array<{ obj: Obj; source: string }> = [];
  const containers: Container[] = [];
  for (const r of resources) {
    const body = resolve(r.body) as Obj;
    const meta = one(body.metadata) ?? {};
    const kind =
      /^kubernetes_deployment/.test(r.type) ? "Deployment"
      : /^kubernetes_stateful_set/.test(r.type) ? "StatefulSet"
      : /^kubernetes_service/.test(r.type) ? "Service"
      : /^kubernetes_ingress/.test(r.type) ? "Ingress"
      : /^kubernetes_config_map/.test(r.type) ? "ConfigMap"
      : undefined;
    if (kind) {
      docs.push({ obj: toManifest(kind, body, meta), source: r.source });
      continue;
    }
    if (r.type === "docker_container") {
      const env: Record<string, string> = {};
      for (const e of (body.env ?? []) as string[]) {
        const at = String(e).indexOf("=");
        if (at > 0) env[String(e).slice(0, at)] = String(e).slice(at + 1);
      }
      const name = String(body.name ?? r.name);
      containers.push({ name, format: "terraform", source: r.source, component: null, image: body.image ? String(body.image) : null, hostnames: [name], ports: [], env });
    }
  }
  const k = fromManifests(docs, "terraform", gateway);
  return { containers: [...k.containers, ...containers], rules: k.rules, warnings };
}

/** The Terraform block shape (`spec { template { spec { container { env { … } } } } }`) as a manifest. */
function toManifest(kind: string, body: Obj, meta: Obj): Obj {
  const one = (x: unknown) => (Array.isArray(x) ? x[0] : x) as Obj | undefined;
  const spec = one(body.spec) ?? {};
  const metadata = { name: meta.name, namespace: meta.namespace, labels: one(meta.labels) ?? meta.labels };
  if (kind === "ConfigMap") return { kind, metadata, data: one(body.data) ?? {} };
  if (kind === "Service") return { kind, metadata, spec: { selector: one(spec.selector) ?? spec.selector ?? {}, ports: (spec.port ?? []).map((p: Obj) => ({ port: p.port })) } };
  if (kind === "Ingress") {
    const rules = (spec.rule ?? []).map((rule: Obj) => ({
      host: rule.host,
      http: {
        paths: (one(rule.http)?.path ?? []).map((p: Obj) => ({
          path: p.path,
          pathType: p.path_type,
          backend: { service: { name: one(one(p.backend)?.service)?.name } },
        })),
      },
    }));
    return { kind, metadata, spec: { rules } };
  }
  const template = one(spec.template) ?? {};
  const podSpec = one(template.spec) ?? {};
  const containers = (podSpec.container ?? []).map((c: Obj) => ({
    name: c.name,
    image: c.image,
    env: (c.env ?? []).map((e: Obj) => ({ name: e.name, value: e.value })),
    envFrom: (c.env_from ?? []).map((e: Obj) => ({ configMapRef: { name: one(e.config_map_ref)?.name } })),
    ports: (c.port ?? []).map((p: Obj) => ({ containerPort: p.container_port })),
  }));
  const templateMeta = one(template.metadata) ?? {};
  return { kind, metadata, spec: { template: { metadata: { labels: one(templateMeta.labels) ?? templateMeta.labels }, spec: { containers } } } };
}
