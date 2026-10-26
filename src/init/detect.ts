import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, posix, relative, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { globSync } from "tinyglobby";
import type { ComponentKind } from "../config/schema.js";

/** Folders never read: dependencies, build output, caches, archmap's own data. */
const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.next/**", "**/.nuxt/**", "**/.turbo/**", "**/.cache/**", "**/.archmap/**", "**/vendor/**", "**/.meteor/local/**"];

/** Code that is never a deployed part: tests, examples, docs and scripts. */
const NOT_APPS = /(^|\/)(test|tests|__tests__|e2e|fixtures?|examples?|docs?|scripts|tools|mocks?|__mocks__|\.?storybook)(\/|$)/;
/** A compose file for tests only, by its name. */
const TEST_COMPOSE = /(^|[.-])(test|tests|e2e)([.-]|$)/;
/** Conventional folders of deployed parts, and of libraries. */
const APP_DIRS = /(^|\/)(apps?|services?|servers?|clients?|frontends?|backends?|web|api|workers?)(\/|$)/;
const LIB_DIRS = /(^|\/)(packages|libs?|shared|common)(\/|$)/;
/** Folders of a full-stack app that hold its browser code. */
const UI_DIRS = ["client", "frontend", "web", "src/client"];

const MOBILE = ["react-native", "expo"];
const DESKTOP = ["electron"];
const WEB = ["next", "nuxt", "react", "react-dom", "vue", "@angular/core", "svelte", "preact", "solid-js", "lit", "@remix-run/react", "astro"];
const SERVER = ["express", "@nestjs/core", "fastify", "koa", "@hapi/hapi", "hapi", "moleculer", "socket.io", "ws", "@apollo/server", "apollo-server", "graphql-yoga", "restify", "@trpc/server", "hono"];
const WORKER = ["bullmq", "bull", "bee-queue", "amqplib", "kafkajs", "nats", "@aws-sdk/client-sqs", "agenda", "node-cron"];
/** Queues that keep their jobs in Redis: with one of them, a Redis container is a bus. */
const REDIS_QUEUES = ["bullmq", "bull", "bee-queue"];
const CLIENT_NAMES = /^(web|webapp|web-app|frontend|front|ui|client|app|admin|dashboard|portal|site|website|desktop|mobile|spa)$/;

/**
 * Rule packs that ship with archmap beyond generic@1, and what shows that a
 * project needs one: a Meteor app, or the SDK of Rocket.Chat.
 */
const PACKS: Array<{ pack: string; needed: (packages: PackageInfo[]) => boolean }> = [
  { pack: "meteor@1", needed: (packages) => packages.some((p) => p.meteor) },
  { pack: "rocketchat@1", needed: (packages) => packages.some((p) => [...p.deps].some((d) => d.startsWith("@rocket.chat/"))) },
];

/** Infrastructure a container image names: the kind of part it is. */
const PRODUCTS: Array<[RegExp, ComponentKind]> = [
  [/^(traefik|nginx|envoy|haproxy|kong|caddy|krakend)/, "gateway"],
  [/^(nats|rabbitmq|kafka|cp-kafka|redpanda|pulsar|activemq|nsq|mosquitto|emqx)/, "bus"],
  [/mongo|postgres|^mysql|^mariadb|mssql|sqlserver|cockroach|cassandra|scylla|couchdb|couchbase|elasticsearch|opensearch|clickhouse|neo4j|influxdb|timescale|memcached/, "database"],
];

export interface PackageInfo {
  repo: string;
  /** Folder in the repository, posix, `.` for its root. */
  dir: string;
  name: string | null;
  deps: Set<string>;
  scripts: Record<string, string>;
  workspaces: boolean;
  dockerfile: boolean;
  indexHtml: boolean;
  meteor: boolean;
}

export interface ComposeService {
  name: string;
  repo: string;
  image: string | null;
  /** Build context in the repository, posix, `.` for its root; null when the service is not built or builds from outside. */
  context: string | null;
  /** Dockerfile in the repository, when the service names one that is there. */
  dockerfile: string | null;
  built: boolean;
}

export interface DetectedComponent {
  id: string;
  kind: ComponentKind;
  include: string[];
  exclude: string[];
  aliases: string[];
  /** Why the part was found and given its kind, for the comment in the config. */
  why: string;
}

export interface Detection {
  name: string;
  repos: Array<{ id: string; path: string }>;
  components: DetectedComponent[];
  infra: { compose: string[]; k8s: string[]; nginx: Array<{ file: string; gateway: string }>; terraform: string[]; helm: Array<{ chart: string; values: string[] }> };
  packs: string[];
}

/** A lowercase id the config accepts: letters, digits, `.`, `_`, `-`, starting with a letter or digit. A commit after `@` is dropped. */
export function idOf(text: string): string {
  const id = text
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/@[0-9a-f]{7,40}$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
  return id || "project";
}

const unique = (taken: Set<string>, id: string) => {
  let out = id;
  for (let i = 2; taken.has(out); i++) out = `${id}-${i}`;
  taken.add(out);
  return out;
};

/** A compose value with its variables replaced by their defaults (`${X:-./dist}` → `./dist`, `${X}` → ``), as on a computer with none of them set. */
export function interpolate(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, _name: string, fallback: string | undefined) => fallback ?? "");
}

/** The repositories of a folder: the folder itself when it is a git repository or holds none, else each git repository inside it. */
export function reposOf(dir: string): Array<{ id: string; abs: string; path: string }> {
  const self = [{ id: idOf(basename(dir)), abs: dir, path: "." }];
  if (existsSync(join(dir, ".git"))) return self;
  const taken = new Set<string>();
  const subs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(dir, d.name, ".git")))
    .map((d) => d.name)
    .sort();
  return subs.length > 0 ? subs.map((name) => ({ id: unique(taken, idOf(name)), abs: join(dir, name), path: `./${name}` })) : self;
}

/** A client or a server-side part, from what its package.json depends on, and why. */
export function kindOfPackage(p: Pick<PackageInfo, "deps" | "name" | "dir" | "meteor">): { kind: "client" | "service"; why: string } {
  const has = (list: string[]) => list.find((d) => p.deps.has(d));
  if (p.meteor) return { kind: "service", why: "a Meteor app" };
  const mobile = has(MOBILE) ?? has(DESKTOP);
  if (mobile) return { kind: "client", why: `${mobile} in package.json` };
  const server = has(SERVER);
  if (server) return { kind: "service", why: `${server} in package.json` };
  const web = has(WEB);
  if (web) return { kind: "client", why: `${web} in package.json` };
  const worker = has(WORKER);
  if (worker) return { kind: "service", why: `${worker} in package.json` };
  const base = (p.name ?? p.dir).replace(/^@[^/]+\//, "").split("/").pop() ?? "";
  if (CLIENT_NAMES.test(base)) return { kind: "client", why: `named ${base}` };
  return { kind: "service", why: "a package with no client framework" };
}

/** Whether a package is a deployed part rather than a library, a test or the root of a workspace that is not an app itself. */
export function deployable(p: PackageInfo, packagesInRepo: number): boolean {
  if (NOT_APPS.test(p.dir)) return false;
  const app = [...MOBILE, ...DESKTOP].some((d) => p.deps.has(d)) || p.meteor || p.dockerfile;
  if (p.workspaces) return app;
  if (app || p.scripts.start !== undefined || p.scripts.serve !== undefined) return true;
  if (p.indexHtml && WEB.some((d) => p.deps.has(d))) return true;
  if (APP_DIRS.test(p.dir) && !LIB_DIRS.test(p.dir)) return true;
  return p.dir === "." && packagesInRepo === 1;
}

function packagesOf(repo: string, abs: string): PackageInfo[] {
  return globSync(["**/package.json"], { cwd: abs, ignore: IGNORE, dot: false })
    .sort()
    .flatMap((file) => {
      try {
        const pkg = JSON.parse(readFileSync(join(abs, file), "utf8")) as { name?: string; dependencies?: object; devDependencies?: object; peerDependencies?: object; scripts?: Record<string, string>; workspaces?: unknown };
        const dir = posix.dirname(file);
        const at = (f: string) => existsSync(join(abs, dir, f));
        return [
          {
            repo,
            dir,
            name: pkg.name ?? null,
            deps: new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]),
            scripts: pkg.scripts ?? {},
            workspaces: pkg.workspaces !== undefined || at("pnpm-workspace.yaml") || at("lerna.json"),
            dockerfile: at("Dockerfile"),
            indexHtml: at("index.html") || at("public/index.html"),
            meteor: at(".meteor/release"),
          },
        ];
      } catch {
        return [];
      }
    });
}

/** A path in the repository, posix, or null when it leaves the repository. */
function inRepo(abs: string, path: string): string | null {
  const rel = relative(abs, path).split("\\").join("/") || ".";
  return rel.startsWith("..") || rel.startsWith("/") ? null : rel;
}

/** The compose files of a repository, test-only ones left out, with their services. */
function composeOf(repo: string, abs: string): Array<{ file: string; services: ComposeService[] }> {
  return globSync(["**/{docker-compose,compose}*.{yml,yaml}"], { cwd: abs, ignore: IGNORE })
    .filter((file) => !NOT_APPS.test(posix.dirname(file)) && !TEST_COMPOSE.test(basename(file).replace(/\.ya?ml$/, "")))
    .sort()
    .flatMap((file) => {
      try {
        const doc = parseYaml(readFileSync(join(abs, file), "utf8")) as { services?: Record<string, { image?: unknown; build?: unknown } | null> } | null;
        if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") return [];
        const base = join(abs, posix.dirname(file));
        const services = Object.entries(doc.services).map(([name, s]): ComposeService => {
          const build = s?.build;
          const spec = typeof build === "string" ? { context: build } : build && typeof build === "object" ? (build as { context?: string; dockerfile?: string }) : null;
          // an override file builds with no context of its own: where the code is stays unknown
          const contextAbs = spec?.context !== undefined ? resolve(base, interpolate(spec.context)) : null;
          let dockerfile: string | null = null;
          if (spec?.dockerfile && contextAbs) {
            const df = interpolate(spec.dockerfile);
            // `${CI_WORKSPACE:-}/apps/x/Dockerfile` names the repository's root once the variable is gone
            const candidates = df.startsWith("/") ? [df, join(abs, df)] : [resolve(contextAbs, df)];
            const found = candidates.find((c) => existsSync(c));
            dockerfile = found ? inRepo(abs, found) : null;
          }
          return { name, repo, image: typeof s?.image === "string" ? interpolate(s.image) : null, context: contextAbs ? inRepo(abs, contextAbs) : null, dockerfile, built: spec !== null };
        });
        return [{ file, services }];
      } catch {
        return [];
      }
    });
}

function textOf(abs: string, file: string): string {
  try {
    return readFileSync(join(abs, file), "utf8");
  } catch {
    return "";
  }
}

/** The product an image names: its last path part without the tag (`mongodb/mongodb-community-server:8` → `mongodb-community-server`). */
function productOf(image: string): string {
  return (image.toLowerCase().split("/").pop() ?? "").split(":")[0] ?? "";
}

/**
 * What a folder holds, as a first config: its repositories, the deployed
 * parts (docker-compose services and the package.json of apps), the browser
 * code of full-stack apps, the databases, buses and gateways the images
 * name, and the infrastructure descriptions. Libraries, tests and examples
 * are left out; their code still counts for the parts that import it.
 */
export function detect(dir: string): Detection {
  const root = resolve(dir);
  const repos = reposOf(root);
  const absOf = new Map(repos.map((r) => [r.id, r.abs]));
  const packages = repos.flatMap((r) => packagesOf(r.id, r.abs));
  const compose = repos.flatMap((r) => composeOf(r.id, r.abs).map((c) => ({ ...c, repo: r.id })));
  const services = new Map<string, ComposeService[]>();
  for (const c of compose) for (const s of c.services) services.set(s.name, [...(services.get(s.name) ?? []), s]);
  const dockerfileUsers = new Map<string, Set<string>>();
  for (const [name, defs] of services) for (const d of defs) if (d.dockerfile) dockerfileUsers.set(`${d.repo}:${d.dockerfile}`, new Set([...(dockerfileUsers.get(`${d.repo}:${d.dockerfile}`) ?? []), name]));
  const usesRedisQueue = packages.some((p) => REDIS_QUEUES.some((d) => p.deps.has(d)));

  const packageAt = (repo: string, d: string) => packages.find((p) => p.repo === repo && p.dir === d);
  const packageAbove = (repo: string, from: string) => {
    for (let d = from; ; d = posix.dirname(d)) {
      if (packageAt(repo, d)) return d;
      if (d === "." || d === "/") return null;
    }
  };
  const byName = (name: string) => {
    const names = new Set([name, name.replace(/-service$/, ""), name.replace(/^service-/, "")]);
    const hits = packages.filter((p) => !p.workspaces && !NOT_APPS.test(p.dir) && (names.has(basename(p.dir)) || names.has((p.name ?? "").replace(/^@[^/]+\//, ""))));
    return hits.find((p) => APP_DIRS.test(p.dir)) ?? hits[0];
  };
  /** The code a compose service runs: its build context, the package of a Dockerfile only it uses, a package of its name, else a context of other code. */
  const codeOf = (defs: ComposeService[]): { repo: string; dir: string; why: string } | null => {
    // a build context at the root of a workspace says nothing: its Dockerfile does
    for (const s of defs) if (s.context && packageAt(s.repo, s.context) && !packageAt(s.repo, s.context)?.workspaces) return { repo: s.repo, dir: s.context, why: "its build context" };
    for (const s of defs) {
      if (!s.dockerfile || (dockerfileUsers.get(`${s.repo}:${s.dockerfile}`)?.size ?? 0) > 1) continue;
      const d = packageAbove(s.repo, posix.dirname(s.dockerfile));
      if (d && d !== ".") return { repo: s.repo, dir: d, why: `its Dockerfile ${s.dockerfile}` };
    }
    const named = byName(defs[0]?.name ?? "");
    if (named) return { repo: named.repo, dir: named.dir, why: `a package named like it` };
    for (const s of defs) if (s.context && s.context !== "." && existsSync(join(absOf.get(s.repo) ?? "", s.context))) return { repo: s.repo, dir: s.context, why: "its build context" };
    return null;
  };

  const taken = new Set<string>();
  type Found = DetectedComponent & { repo?: string; dir?: string };
  const components: Found[] = [];
  const byDir = new Map<string, Found>();
  const addCode = (repo: string, d: string, preferredId: string, why: string, alias?: string): Found => {
    const existing = byDir.get(`${repo}:${d}`);
    if (existing) {
      if (alias && alias !== existing.id && !existing.aliases.includes(alias)) existing.aliases.push(alias);
      return existing;
    }
    const pkg = packageAt(repo, d);
    const k = pkg ? kindOfPackage(pkg) : { kind: "service" as const, why: "no package.json" };
    const c: Found = { id: unique(taken, idOf(preferredId)), kind: k.kind, include: [`${repo}:${d === "." ? "**" : `${d}/**`}`], exclude: [], aliases: [], why: `${why}; ${k.why}`, repo, dir: d };
    if (alias && alias !== c.id) c.aliases.push(alias);
    byDir.set(`${repo}:${d}`, c);
    components.push(c);
    return c;
  };

  // the services docker-compose runs from the repositories' code
  const composed = new Set<string>();
  for (const [name, defs] of services) {
    const code = codeOf(defs);
    if (code) {
      addCode(code.repo, code.dir, name, `docker-compose service ${name}, by ${code.why}`, name);
      composed.add(name);
    }
  }
  // apps compose does not name: a client always, a server-side part only when compose names none
  for (const r of repos) {
    const own = packages.filter((p) => p.repo === r.id);
    for (const p of own.filter((x) => deployable(x, own.length))) {
      if (byDir.has(`${r.id}:${p.dir}`)) continue;
      if (composed.size > 0 && kindOfPackage(p).kind === "service") continue;
      addCode(r.id, p.dir, p.dir === "." ? r.id : basename(p.dir), p.dockerfile ? "a Dockerfile" : p.scripts.start !== undefined ? "a start script" : "an app folder");
    }
  }
  // nothing found: each repository is one part
  if (components.length === 0) for (const r of repos) addCode(r.id, ".", r.id, "the whole repository");

  // the browser code of a full-stack app is a client of its own
  for (const c of [...components]) {
    const pkg = c.repo !== undefined && c.dir !== undefined ? packageAt(c.repo, c.dir) : undefined;
    if (c.kind !== "service" || !pkg || !WEB.some((d) => pkg.deps.has(d))) continue;
    const abs = absOf.get(pkg.repo) ?? "";
    const ui = UI_DIRS.map((u) => (pkg.dir === "." ? u : `${pkg.dir}/${u}`)).find((u) => globSync([`${u}/**/*.{tsx,jsx,vue,svelte}`], { cwd: abs, ignore: IGNORE }).length >= 5);
    if (!ui) continue;
    const client: Found = { id: unique(taken, `${c.id}-client`), kind: "client", include: [`${pkg.repo}:${ui}/**`], exclude: [], aliases: [], why: `the browser code of ${c.id} in ${ui}`, repo: pkg.repo, dir: ui };
    components.push(client);
  }

  // databases, buses and gateways the images name
  for (const [name, defs] of services) {
    if (components.some((c) => c.id === name || c.aliases.includes(name))) continue;
    const image = defs.map((d) => d.image).find((i) => i) ?? "";
    const product = productOf(image);
    const known = PRODUCTS.find(([re]) => re.test(product) || re.test(name));
    const kind = known?.[1] ?? (/^(redis|valkey|keydb)/.test(product) ? (usesRedisQueue ? "bus" : "database") : null);
    if (!kind) continue;
    components.push({ id: unique(taken, idOf(name)), kind, include: [], exclude: [], aliases: [], why: `docker-compose service ${name}, image ${image || "?"}${kind === "bus" && /redis/.test(product) ? ", queues in Redis" : ""}` });
  }

  // a part's code leaves out the parts nested in it
  const code = components.filter((c) => c.repo !== undefined && c.dir !== undefined);
  for (const a of code) {
    for (const b of code) {
      if (a !== b && a.repo === b.repo && (a.dir === "." ? b.dir !== "." : (b.dir ?? "").startsWith(`${a.dir}/`))) a.exclude.push(`${b.repo}:${b.dir}/**`);
    }
  }

  // infrastructure descriptions
  const infra: Detection["infra"] = { compose: [], k8s: [], nginx: [], terraform: [], helm: [] };
  for (const c of compose) infra.compose.push(`${c.repo}:${c.file}`);
  const gatewayOf = (product: string) => components.find((c) => c.kind === "gateway" && c.id.includes(product))?.id;
  for (const r of repos) {
    for (const chart of globSync(["**/Chart.yaml"], { cwd: r.abs, ignore: IGNORE }).sort()) {
      const d = posix.dirname(chart);
      if (NOT_APPS.test(d)) continue;
      const values = globSync([`${d === "." ? "" : `${d}/`}values*.{yaml,yml}`], { cwd: r.abs, ignore: IGNORE }).sort();
      infra.helm.push({ chart: `${r.id}:${d}`, values: values.map((v) => `${r.id}:${v}`) });
    }
    const charts = infra.helm.filter((h) => h.chart.startsWith(`${r.id}:`)).map((h) => h.chart.slice(r.id.length + 1));
    for (const file of globSync(["**/*.{yaml,yml}"], { cwd: r.abs, ignore: [...IGNORE, "**/{docker-,}compose*.{yml,yaml}"] }).sort()) {
      if (charts.some((d) => file.startsWith(`${d}/`)) || NOT_APPS.test(file) || !/(^|\/)(k8s|kubernetes|manifests?|deploy|deployments?|kustomize)(\/|$)/.test(file)) continue;
      const text = textOf(r.abs, file);
      if (/^apiVersion:/m.test(text) && /^kind:\s*(Deployment|StatefulSet|DaemonSet|Service|Ingress|CronJob|Job)\b/m.test(text)) infra.k8s.push(`${r.id}:${file}`);
    }
    for (const file of globSync(["**/*.conf", "**/nginx*.conf*"], { cwd: r.abs, ignore: IGNORE }).sort()) {
      if (NOT_APPS.test(file)) continue;
      const text = textOf(r.abs, file);
      if (/\bserver\s*\{/.test(text) && /\blocation\b/.test(text)) infra.nginx.push({ file: `${r.id}:${file}`, gateway: gatewayOf("nginx") ?? "nginx" });
    }
    const tfDirs = [...new Set(globSync(["**/*.tf"], { cwd: r.abs, ignore: [...IGNORE, "**/.terraform/**"] }).map((f) => posix.dirname(f)))].filter((d) => !NOT_APPS.test(d)).sort();
    for (const d of tfDirs) infra.terraform.push(`${r.id}:${d === "." ? "" : `${d}/`}*.tf`);
  }
  if (infra.nginx.some((n) => n.gateway === "nginx") && !components.some((c) => c.id === "nginx")) {
    components.push({ id: unique(taken, "nginx"), kind: "gateway", include: [], exclude: [], aliases: [], why: "nginx configuration files" });
  }

  const order: ComponentKind[] = ["client", "service", "scheduler", "gateway", "bus", "database", "external"];
  return {
    name: idOf(basename(root)),
    repos: repos.map((r) => ({ id: r.id, path: r.path })),
    components: components
      .map(({ repo: _repo, dir: _dir, ...c }) => c)
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.id < b.id ? -1 : 1)),
    infra,
    packs: ["generic@1", ...PACKS.filter((p) => p.needed(packages)).map((p) => p.pack)],
  };
}

export interface AvailableModels {
  /** Ollama and the models in it that can chat. */
  ollama: { url: string; chat: string[] } | null;
  /** The `claude` command of Claude Code. */
  claudeCode: boolean;
  /** `ANTHROPIC_API_KEY` is set. */
  apiKey: boolean;
}

/** Which language models this computer offers: Ollama's chat models, Claude Code, an API key. */
export async function availableModels(url = "http://127.0.0.1:11434"): Promise<AvailableModels> {
  let ollama: AvailableModels["ollama"] = null;
  try {
    const tags = (await (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) })).json()) as { models?: Array<{ name: string }> };
    const chat: string[] = [];
    for (const m of (tags.models ?? []).slice(0, 30)) {
      const show = (await (await fetch(`${url}/api/show`, { method: "POST", body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(5000) })).json()) as { capabilities?: string[] };
      if (!show.capabilities || show.capabilities.includes("completion")) chat.push(m.name);
    }
    ollama = { url, chat };
  } catch {
    // no Ollama on this computer, or it is not running
  }
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10000 });
  return { ollama, claudeCode: claude.status === 0, apiKey: Boolean(process.env.ANTHROPIC_API_KEY) };
}
