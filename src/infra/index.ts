import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import { splitRepoGlob, type TargetConfig } from "../config/schema.js";
import { type Db, setMeta } from "../store/db.js";
import { parseCompose, parseDotEnv } from "./compose.js";
import { type HelmRenderer, helmTemplate } from "./helm.js";
import { fromManifests, loadManifests } from "./kubernetes.js";
import type { Container, GatewayRule, InfraFacts } from "./model.js";
import { nginxRules } from "./nginx.js";
import { fromTerraform } from "./terraform.js";

export interface InfraInput {
  config: TargetConfig;
  /** Inventoried files, `repo` and `path`. */
  files: Array<{ repo: string; path: string }>;
  /** Directory of each repository's files. */
  dirOf: (repo: string) => string;
  helm?: HelmRenderer;
}

/**
 * Reads every infrastructure description the config lists and maps its
 * containers to components: a container named like a component (or one of
 * its aliases, or reachable by such a host name) belongs to it.
 */
export async function extractInfra(input: InfraInput): Promise<InfraFacts> {
  const { config } = input;
  const read = (repo: string, path: string) => readFileSync(join(input.dirOf(repo), path), "utf8");
  const filesOf = (repoGlob: string) => {
    const { repo, glob } = splitRepoGlob(repoGlob);
    const match = picomatch(glob, { dot: true });
    return input.files.filter((f) => f.repo === repo && match(f.path));
  };
  const entry = (e: string | { file: string; gateway: string }, gateway: string) => (typeof e === "string" ? { file: e, gateway } : e);
  const containers: Container[] = [];
  const rules: GatewayRule[] = [];
  const warnings: string[] = [];

  for (const glob of config.infra.compose) {
    const found = filesOf(glob);
    if (found.length === 0) warnings.push(`no compose file matches ${glob}`);
    for (const f of found) {
      const envPath = posix.join(posix.dirname(f.path), ".env");
      const dotEnv = input.files.some((x) => x.repo === f.repo && x.path === envPath) ? parseDotEnv(read(f.repo, envPath)) : {};
      const r = parseCompose(read(f.repo, f.path), `${f.repo}:${f.path}`, { ...dotEnv, ...config.infra.env });
      containers.push(...r.containers);
      rules.push(...r.rules);
    }
  }
  for (const e of config.infra.nginx.map((x) => entry(x, "nginx"))) {
    for (const f of filesOf(e.file)) rules.push(...nginxRules(read(f.repo, f.path), `${f.repo}:${f.path}`, e.gateway));
  }
  for (const e of config.infra.k8s.map((x) => entry(x, "ingress"))) {
    const docs = filesOf(e.file).flatMap((f) => loadManifests(read(f.repo, f.path), `${f.repo}:${f.path}`));
    const r = fromManifests(docs, "kubernetes", e.gateway);
    containers.push(...r.containers);
    rules.push(...r.rules);
  }
  for (const h of config.infra.helm) {
    const { repo, glob } = splitRepoGlob(h.chart);
    const values = h.values.flatMap((v) => filesOf(v).map((f) => join(input.dirOf(f.repo), f.path)));
    const rendered = (input.helm ?? helmTemplate)(join(input.dirOf(repo), glob), values, h.release);
    if ("error" in rendered) {
      warnings.push(`${h.chart}: ${rendered.error}; the chart was skipped`);
      continue;
    }
    const r = fromManifests(loadManifests(rendered.manifests, `${h.chart}(rendered)`), "helm", h.gateway);
    containers.push(...r.containers);
    rules.push(...r.rules);
  }
  const tf = config.infra.terraform.map((x) => entry(x, "ingress"));
  if (tf.length > 0) {
    const texts = tf.flatMap((e) => filesOf(e.file).map((f) => ({ text: read(f.repo, f.path), file: `${f.repo}:${f.path}` })));
    const r = await fromTerraform(texts, tf[0]?.gateway ?? "ingress");
    containers.push(...r.containers);
    rules.push(...r.rules);
    warnings.push(...r.warnings);
  }

  const byName = new Map<string, string>();
  for (const c of config.components) {
    byName.set(c.id, c.id);
    for (const a of c.aliases) byName.set(a, c.id);
  }
  for (const c of containers) c.component = byName.get(c.name) ?? c.hostnames.map((h) => byName.get(h)).find((x) => x !== undefined) ?? null;
  for (const r of rules) r.gateway = byName.get(r.gateway) ?? r.gateway;
  return { containers, rules, warnings };
}

export function writeInfra(db: Db, facts: InfraFacts, key: string): void {
  const insertContainer = db.prepare(
    `INSERT INTO container(name, format, source, component, image, hostnames, ports, env)
     VALUES (@name, @format, @source, @component, @image, @hostnames, @ports, @env)`,
  );
  const insertRule = db.prepare(
    `INSERT INTO gateway_rule(gateway, match, path, host, strip, replace, target, priority, source)
     VALUES (@gateway, @match, @path, @host, @strip, @replace, @target, @priority, @source)`,
  );
  db.transaction(() => {
    db.exec("DELETE FROM container; DELETE FROM gateway_rule;");
    for (const c of facts.containers) {
      insertContainer.run({ ...c, hostnames: JSON.stringify(c.hostnames), ports: JSON.stringify(c.ports), env: JSON.stringify(c.env) });
    }
    for (const r of facts.rules) insertRule.run(r);
    setMeta(db, "infra.key", key);
    setMeta(db, "infra.warnings", JSON.stringify(facts.warnings));
  })();
}

export function loadInfra(db: Db): InfraFacts {
  const containers = (db.prepare("SELECT * FROM container ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => ({
    name: String(r.name),
    format: r.format as Container["format"],
    source: String(r.source),
    component: r.component === null ? null : String(r.component),
    image: r.image === null ? null : String(r.image),
    hostnames: JSON.parse(String(r.hostnames)) as string[],
    ports: JSON.parse(String(r.ports)) as number[],
    env: JSON.parse(String(r.env)) as Record<string, string>,
  }));
  const rules = (db.prepare("SELECT * FROM gateway_rule ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => ({
    gateway: String(r.gateway),
    match: r.match as GatewayRule["match"],
    path: String(r.path),
    host: r.host === null ? null : String(r.host),
    strip: r.strip === null ? null : String(r.strip),
    replace: r.replace === null ? null : String(r.replace),
    target: String(r.target),
    priority: Number(r.priority),
    source: String(r.source),
  }));
  return { containers, rules, warnings: [] };
}
