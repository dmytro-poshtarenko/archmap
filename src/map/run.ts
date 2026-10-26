import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import type { Sources } from "../match/resolve.js";
import { loadLinks, matchingOf } from "../match/run.js";
import { type Db, getMeta } from "../store/db.js";
import { renderModel } from "./dsl.js";
import { type Feature, type FeatureRequest, featureOf, renderFeature, slugOf } from "./feature.js";
import { buildGraph, type ExternalCall, type GatewayRoute, type MapGraph, SYSTEM } from "./graph.js";
import { type Diagnostic, validateWorkspace } from "./likec4.js";

/** The model file of a map: named so the viewer lists its C1, C2 and C3 views before the feature views. */
export const MODEL_FILE = "c4-model.c4";

export function mapDir(dataRoot: string, target: string, run: string): string {
  return join(dataRoot, "out", target, run, "likec4");
}

/** The map built last: `data/out/<target>/current`, a link to that run's LikeC4 workspace. */
export function currentMapDir(dataRoot: string, target: string): string {
  return join(dataRoot, "out", target, "current");
}

/** The run of the map built last, when there is one. */
export function currentMapRun(dataRoot: string, target: string): string | null {
  const link = currentMapDir(dataRoot, target);
  if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) return null;
  return basename(dirname(readlinkSync(link)));
}

/** The run a map is drawn from by default: the full method with the model's answers when it exists, else the rules and infrastructure alone. */
export function defaultMapRun(db: Db): string {
  const derived = db.prepare("SELECT id FROM run WHERE id LIKE 'full.select.%' ORDER BY created_at DESC LIMIT 1").pluck().get() as string | undefined;
  return derived ?? "full";
}

/** The product's name on the map: the last part of the main repository's URL (`Rocket.Chat`), else the config's name. */
export function productName(config: TargetConfig): string {
  const url = config.repos.find((r) => r.role === "main" && r.url)?.url;
  return url?.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? config.name;
}

/** Reads a file of a repository of the target; it throws when the file does not exist. */
export type RepoReader = (repo: string, path: string) => string;

/**
 * The map of a run. A call site belongs to the parts that run it under the
 * run's deployment, as the method narrows them (service registrations and
 * load conditions the profile switches off); with a reader, the parts also
 * get the technologies their package.json and images name.
 */
export function graphOf(db: Db, config: TargetConfig, run: string, read?: RepoReader): MapGraph {
  const links = loadLinks(db, run);
  if (links.length === 0) throw new Error(`run '${run}' has no links; run \`archmap match\` first`);
  const { resolver, sites } = matchingOf(db, config);
  const sources = sourcesOf(db, run);
  const units = new Map((db.prepare("SELECT repo_id AS repo, path, code_unit AS unit FROM file").all() as Array<{ repo: string; path: string; unit: string | null }>).map((f) => [`${f.repo}:${f.path}`, f.unit]));
  return buildGraph(config, run, sites, links, {
    routing: loadRouting(db),
    externals: loadExternals(db, run),
    product: productName(config),
    protocols: loadProtocols(db),
    technologies: read ? loadTechnologies(db, config, read) : undefined,
    componentsOf: (site) => resolver.componentsOf(site, sources),
    packageOf: (site) => {
      const unit = units.get(`${site.repo}:${site.path}`);
      const root = unit ? unit.slice(unit.indexOf(":") + 1) : null;
      return root && root !== "." ? root : site.repo;
    },
  });
}

/** What the run's variant lets the narrowing use: with the infrastructure, the deployment's environment. */
function sourcesOf(db: Db, run: string): Sources {
  const row = db.prepare("SELECT variant FROM run WHERE id = ?").get(run) as { variant: string } | undefined;
  const v = row ? (JSON.parse(row.variant) as { rules?: boolean; infra?: boolean; llm?: boolean }) : {};
  return { rules: v.rules ?? true, llmRoutes: v.llm ?? true, env: v.infra ?? true, gateway: v.infra ?? true };
}

/** Frameworks a package.json names, for a client and for a server-side container. */
const CLIENT_FRAMEWORKS: Array<[string, string]> = [
  ["react-native", "React Native"],
  ["electron", "Electron"],
  ["next", "Next.js"],
  ["preact", "Preact"],
  ["react", "React"],
  ["vue", "Vue"],
  ["@angular/core", "Angular"],
  ["svelte", "Svelte"],
];
const SERVER_FRAMEWORKS: Array<[string, string]> = [
  ["moleculer", "Moleculer"],
  ["@nestjs/core", "NestJS"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["@hapi/hapi", "hapi"],
  ["next", "Next.js"],
  ["socket.io", "Socket.IO"],
  ["bullmq", "BullMQ"],
  ["ws", "ws (WebSocket)"],
];
/** Products an image names, for parts that run a known image: databases, buses, gateways. */
const PRODUCTS: Array<[string, string]> = [
  ["mongo", "MongoDB"],
  ["nats", "NATS"],
  ["redis", "Redis"],
  ["rabbitmq", "RabbitMQ"],
  ["kafka", "Kafka"],
  ["postgres", "PostgreSQL"],
  ["mysql", "MySQL"],
  ["mariadb", "MariaDB"],
  ["traefik", "Traefik"],
  ["nginx", "nginx"],
  ["envoy", "Envoy"],
  ["haproxy", "HAProxy"],
];

/**
 * What each part is built with: a known product and version from its
 * container image (`mongodb/mongodb-community-server:8.0` → MongoDB 8.0), else
 * the frameworks the package.json of its code names, with Meteor when the
 * code unit is a Meteor app (`.meteor/release`).
 */
function loadTechnologies(db: Db, config: TargetConfig, read: RepoReader): Record<string, string> {
  const out: Record<string, string> = {};
  const tryRead = (repo: string, path: string) => {
    try {
      return read(repo, path);
    } catch {
      return null;
    }
  };
  for (const c of db.prepare("SELECT component, image FROM container WHERE component IS NOT NULL AND image IS NOT NULL").all() as Array<{ component: string; image: string }>) {
    const [name, tag] = c.image.toLowerCase().split(/:(?=[^/:]*$)/) as [string, string | undefined];
    const product = PRODUCTS.find(([k]) => name.includes(k));
    const version = tag ? /\d+(?:\.\d+)?/.exec(tag)?.[0] : undefined;
    if (product) out[c.component] ??= version ? `${product[1]} ${version}` : product[1];
  }
  const kindOf = new Map(config.components.map((c) => [c.id, c.kind]));
  const units = db.prepare("SELECT DISTINCT f.component AS component, cu.repo_id AS repo, cu.root AS root FROM file f JOIN code_unit cu ON cu.id = f.code_unit WHERE f.component IS NOT NULL").all() as Array<{ component: string; repo: string; root: string }>;
  const found = new Map<string, string[]>();
  for (const u of units) {
    const dir = u.root === "." ? "" : `${u.root}/`;
    const pkg = tryRead(u.repo, `${dir}package.json`);
    if (pkg === null) continue;
    let deps: Record<string, string> = {};
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      deps = { ...parsed.dependencies, ...parsed.devDependencies };
    } catch {
      continue;
    }
    const client = kindOf.get(u.component) === "client";
    const names = (client ? CLIENT_FRAMEWORKS : SERVER_FRAMEWORKS).filter(([k]) => k in deps).map(([, label]) => label);
    // React under React Native or Preact is a compatibility layer, not the framework
    const own = names.filter((n) => !(n === "React" && (names.includes("React Native") || names.includes("Preact"))));
    const meteor = tryRead(u.repo, `${dir}.meteor/release`) !== null ? ["Meteor"] : [];
    found.set(u.component, [...new Set([...(found.get(u.component) ?? []), ...(client ? [] : ["Node.js"]), ...meteor, ...own])]);
  }
  for (const [component, names] of found) if (names.length > 0) out[component] ??= names.join(", ");
  return out;
}

/** Protocol names by URL scheme and by container image. */
const SCHEMES: Record<string, string> = {
  nats: "NATS",
  mongodb: "MongoDB",
  "mongodb+srv": "MongoDB",
  redis: "Redis",
  rediss: "Redis",
  amqp: "AMQP",
  amqps: "AMQP",
  kafka: "Kafka",
  postgres: "PostgreSQL",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
};
const IMAGES: Array<[string, string]> = [
  ["nats", "NATS"],
  ["mongo", "MongoDB"],
  ["redis", "Redis"],
  ["rabbitmq", "AMQP"],
  ["kafka", "Kafka"],
  ["postgres", "PostgreSQL"],
  ["mysql", "MySQL"],
  ["mariadb", "MySQL"],
];

/**
 * The protocol each part is reached by, from the infrastructure step: the
 * scheme of the URLs other containers use for it (`TRANSPORTER=nats://nats:4222`
 * → NATS), else what its image is (`mongodb/mongodb-community-server` → MongoDB).
 */
function loadProtocols(db: Db): Record<string, string> {
  const containers = db.prepare("SELECT name, component, image, env FROM container").all() as Array<{ name: string; component: string | null; image: string | null; env: string }>;
  const byName = new Map(containers.map((c) => [c.name, c]));
  const out: Record<string, string> = {};
  for (const c of containers) {
    for (const value of Object.values(JSON.parse(c.env) as Record<string, unknown>)) {
      const m = typeof value === "string" ? /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^:/?,]+)/i.exec(value) : null;
      const protocol = m ? SCHEMES[(m[1] as string).toLowerCase()] : undefined;
      const target = m ? byName.get(m[2] as string) : undefined;
      if (protocol && target?.component) out[target.component] ??= protocol;
    }
  }
  for (const c of containers) {
    const known = c.component && c.image ? IMAGES.find(([k]) => (c.image as string).toLowerCase().includes(k)) : undefined;
    if (known && c.component) out[c.component] ??= known[1];
  }
  return out;
}

/**
 * Calls the run sends outside the system, with the URL they reach. A base
 * address taken from a setting gets the setting's default value from the code
 * (`{setting:Cloud_Url}` → `https://cloud.rocket.chat`).
 */
function loadExternals(db: Db, run: string): ExternalCall[] {
  const defaults = JSON.parse(getMeta(db, "extract.settingDefaults") ?? "{}") as Record<string, string>;
  const rows = db
    .prepare(
      `SELECT s.id AS site, s.display, s.components FROM link l JOIN call_site s ON s.id = l.site
       WHERE l.run = ? AND l.status = 'none' AND l.reason = 'external'`,
    )
    .all(run) as Array<{ site: string; display: string; components: string }>;
  return rows
    .map((r) => ({ site: r.site, url: r.display.replace(/^\{setting:([^}]+)\}/, (whole, key: string) => defaults[key] ?? whole), components: JSON.parse(r.components) as string[] }))
    .filter((c) => /^https?:\/\//.test(c.url));
}

/** The gateways' routing rules by the part each sends requests to, from the infrastructure step. */
function loadRouting(db: Db): GatewayRoute[] {
  const rows = db
    .prepare(
      `SELECT gw.component AS gateway, t.component AS target, g.path, g.source
       FROM gateway_rule g JOIN container gw ON gw.name = g.gateway JOIN container t ON t.name = g.target
       WHERE gw.component IS NOT NULL AND t.component IS NOT NULL`,
    )
    .all() as Array<{ gateway: string; target: string; path: string; source: string }>;
  const routes = new Map<string, GatewayRoute>();
  for (const r of rows) {
    const key = `${r.gateway}|${r.target}`;
    const route = routes.get(key) ?? { gateway: r.gateway, target: r.target, paths: [], sources: [] };
    route.paths.push(r.path);
    route.sources.push(r.source);
    routes.set(key, route);
  }
  return [...routes.values()];
}

/**
 * Writes the LikeC4 workspace of a run (`c4-model.c4`, keeping the feature
 * views made earlier) and validates it. A valid map becomes the one `current`
 * points to, when that link is given.
 */
export async function buildMap(
  db: Db,
  config: TargetConfig,
  run: string,
  dir: string,
  opts: { current?: string; read?: RepoReader } = {},
): Promise<{ graph: MapGraph; diagnostics: Diagnostic[] }> {
  const { current, read } = opts;
  const graph = graphOf(db, config, run, read);
  mkdirSync(dir, { recursive: true });
  const product = productName(config);
  const containers = graph.elements.filter((e) => e.parent === null && e.kind !== "system" && e.kind !== "external").length;
  const links = graph.relations.filter((r) => r.source !== SYSTEM).length;
  const about = `${product}: ${containers} containers, the external systems they call, and ${links} links between them, found by run ${run}. Hover an element or an arrow for its routes and callers.`;
  rmSync(join(dir, "model.c4"), { force: true }); // the name maps had before the C4 levels
  writeFileSync(join(dir, MODEL_FILE), renderModel(graph, product, about));
  // the viewer's tab and project title
  writeFileSync(join(dir, "likec4.config.json"), `${JSON.stringify({ name: config.name, title: `${product}: C4 Diagrams` }, null, 2)}\n`);
  const diagnostics = await validateWorkspace(dir);
  if (current && diagnostics.length === 0) pointCurrent(current, dir);
  return { graph, diagnostics };
}

function pointCurrent(link: string, dir: string): void {
  try {
    if (lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { force: true });
    symlinkSync(relative(dirname(link), dir), link, "dir");
  } catch {
    // a file system without symbolic links: commands then name the run
  }
}

/** Adds (or replaces) a feature view in a built workspace and validates it. */
export async function addFeatureView(graph: MapGraph, dir: string, req: FeatureRequest, run: string): Promise<{ feature: Feature; diagnostics: Diagnostic[] }> {
  const feature = featureOf(graph, req);
  if (feature.elements.length === 0) throw new Error(`no element matches the seeds ${req.seeds.join(", ")}`);
  writeFileSync(join(dir, `feature_${feature.slug}.c4`), renderFeature(graph, feature, req, run));
  return { feature, diagnostics: await validateWorkspace(dir) };
}

/** Removes a feature view, named by its view id (`feature_user_presence`) or by the name it was made with. */
export function removeFeatureView(dir: string, view: string): string {
  const slug = view.startsWith("feature_") && existsSync(join(dir, `${view}.c4`)) ? view.slice("feature_".length) : slugOf(view);
  const file = join(dir, `feature_${slug}.c4`);
  if (!existsSync(file)) throw new Error(`no feature view ${view} in ${dir}`);
  rmSync(file);
  return `feature_${slug}`;
}

export function featureFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^feature_.*\.c4$/.test(f));
}
