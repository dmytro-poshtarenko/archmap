import { loadAll } from "js-yaml";
import type { Container, GatewayRule } from "./model.js";

type Obj = Record<string, any>;

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "ReplicaSet", "Pod"]);

/** Kubernetes objects as plain values, with the file line of each document. */
export function loadManifests(text: string, file: string): Array<{ obj: Obj; source: string }> {
  const out: Array<{ obj: Obj; source: string }> = [];
  const starts = [1];
  text.split("\n").forEach((l, i) => {
    if (/^---/.test(l)) starts.push(i + 2);
  });
  loadAll(text).forEach((doc, i) => {
    if (doc && typeof doc === "object") out.push({ obj: doc as Obj, source: `${file}:${starts[i] ?? 1}` });
  });
  return out;
}

/**
 * Workloads become containers (environment from `env` and `envFrom`
 * ConfigMaps), Services add the names a workload is reached by, and Ingress
 * paths become gateway rules towards the workload behind the Service.
 */
export function fromManifests(
  docs: Array<{ obj: Obj; source: string }>,
  format: Container["format"],
  gateway: string,
): { containers: Container[]; rules: GatewayRule[] } {
  const configMaps = new Map<string, Record<string, string>>();
  for (const { obj } of docs) if (obj.kind === "ConfigMap") configMaps.set(obj.metadata?.name, obj.data ?? {});
  const containers: Array<Container & { labels: Record<string, string> }> = [];
  for (const { obj, source } of docs) {
    if (!WORKLOADS.has(obj.kind)) continue;
    const template = obj.kind === "Pod" ? obj : obj.kind === "CronJob" ? obj.spec?.jobTemplate?.spec?.template : obj.spec?.template;
    const spec = template?.spec ?? {};
    const env: Record<string, string> = {};
    const ports = new Set<number>();
    for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])] as Obj[]) {
      for (const from of (c.envFrom ?? []) as Obj[]) Object.assign(env, configMaps.get(from.configMapRef?.name) ?? {});
      for (const e of (c.env ?? []) as Obj[]) if (e.name && e.value !== undefined) env[e.name] = String(e.value);
      for (const p of (c.ports ?? []) as Obj[]) if (p.containerPort) ports.add(Number(p.containerPort));
    }
    const name = obj.metadata?.name ?? "?";
    containers.push({
      name,
      format,
      source,
      component: null,
      image: (spec.containers?.[0]?.image as string | undefined) ?? null,
      hostnames: [name],
      ports: [...ports],
      env,
      labels: { ...(obj.metadata?.labels ?? {}), ...(template?.metadata?.labels ?? {}) },
    });
  }
  const services = new Map<string, string[]>();
  for (const { obj } of docs) {
    if (obj.kind !== "Service") continue;
    const name = obj.metadata?.name;
    const ns = obj.metadata?.namespace ?? "default";
    const selector: Record<string, string> = obj.spec?.selector ?? {};
    const targets = containers.filter((c) => Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => c.labels[k] === v));
    services.set(name, targets.map((t) => t.name));
    for (const t of targets) {
      t.hostnames.push(name, `${name}.${ns}`, `${name}.${ns}.svc.cluster.local`);
      for (const p of (obj.spec?.ports ?? []) as Obj[]) if (p.port) t.ports.push(Number(p.port));
    }
  }
  const rules: GatewayRule[] = [];
  for (const { obj, source } of docs) {
    if (obj.kind !== "Ingress") continue;
    for (const rule of (obj.spec?.rules ?? []) as Obj[]) {
      for (const p of (rule.http?.paths ?? []) as Obj[]) {
        const service = p.backend?.service?.name ?? p.backend?.serviceName;
        for (const target of services.get(service) ?? [service]) {
          const path = p.path ?? "/";
          rules.push({
            gateway,
            match: p.pathType === "Exact" ? "exact" : "prefix",
            path,
            host: rule.host ?? null,
            strip: null,
            replace: null,
            target,
            priority: (p.pathType === "Exact" ? 2000 : 1000) + path.length,
            source,
          });
        }
      }
    }
  }
  return {
    containers: containers.map(({ labels: _labels, ...c }) => ({ ...c, hostnames: [...new Set(c.hostnames)], ports: [...new Set(c.ports)].sort((a, b) => a - b) })),
    rules,
  };
}
