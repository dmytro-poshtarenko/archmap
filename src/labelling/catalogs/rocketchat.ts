import type { CatalogEntry } from "../catalog.js";
import type { Snapshot } from "../snapshot.js";

type Entry = Omit<CatalogEntry, "origin">;

/**
 * Where a broker service runs in the microservices profile (TRANSPORTER points
 * at NATS). The Meteor server registers these services only when it is not
 * running as microservices (`isRunningMs()` in server/services/startup.ts and
 * ee/server/startup/services.ts); each runs in its own container, registered by
 * ee/apps/<app>/src/service.ts. Every other service runs in the Meteor server.
 */
export const SERVICE_HOSTS: Record<string, string> = {
  presence: "presence-service",
  authorization: "authorization-service",
  abac: "authorization-service",
  accounts: "account-service",
  "queue-worker": "queue-worker-service",
  "omnichannel-transcript": "omnichannel-transcript-service",
};
const SERVER = "rocketchat";
const STREAMER = "ddp-streamer-service";

/**
 * Reference catalog of Rocket.Chat targets, read with plain text patterns from
 * the typed declarations of the snapshot: REST routes (rest-typings and the
 * API.v1 router), DDP methods (ServerMethods) and streams, broker service
 * actions (core-services interfaces) and events, MongoDB collections (model
 * classes) and cron jobs. It only helps annotators type keys; any key may be
 * entered by hand.
 */
export function extractRocketChatCatalog(snapshot: Snapshot): Entry[] {
  const entries = new Map<string, Entry>();
  const add = (e: Entry) => {
    if (!entries.has(e.key)) entries.set(e.key, e);
  };
  const files = (prefix: string, repo = "main") =>
    snapshot.files.filter((f) => f.repo === repo && f.path.startsWith(prefix) && (f.lang === "ts" || f.lang === "tsx"));
  const text = (path: string, repo = "main") => (snapshot.has(repo, path) ? snapshot.read(repo, path) : "");

  // REST: rest-typings ('/v1/rooms.info': { GET: ... }) served under /api by the Meteor server.
  for (const f of files("packages/rest-typings/src/")) {
    let route: { path: string; line: number } | undefined;
    text(f.path)
      .split("\n")
      .forEach((line, i) => {
        const key = /^\s*'(\/[^']+)':\s*\{/.exec(line);
        if (key?.[1]) route = { path: key[1], line: i + 1 };
        const verb = /^\s*(GET|POST|PUT|PATCH|DELETE)\s*:/.exec(line);
        if (route && verb?.[1]) {
          const name = `/api${route.path}`;
          add({ key: `http:${verb[1]}:${name}@${SERVER}`, kind: "http", name, component: SERVER, source: `main:${f.path}:${route.line}`, note: "rest-typings" });
        }
      });
  }
  // REST: routes declared with the API.v1 router but missing from rest-typings.
  for (const f of [...files("apps/meteor/server/api/"), ...files("apps/meteor/ee/server/api/")]) {
    const src = text(f.path);
    for (const m of src.matchAll(/API\.v1\.(addRoute|get|post|put|delete)\(\s*(\[[^\]]*\]|'[^']+')/g)) {
      const names = [...(m[2] ?? "").matchAll(/'([^']+)'/g)].map((n) => n[1] ?? "");
      const verbs = m[1] === "addRoute" ? addRouteVerbs(src, m.index + m[0].length) : [(m[1] ?? "").toUpperCase()];
      for (const n of names) {
        const name = `/api/v1/${n}`;
        for (const verb of verbs.length > 0 ? verbs : ["*"]) {
          if (![...entries.keys()].some((k) => k.startsWith(`http:${verb}:${name}@`))) {
            add({ key: `http:${verb}:${name}@${SERVER}`, kind: "http", name, component: SERVER, source: `main:${f.path}:${lineAt(src, m.index)}`, note: "API.v1" });
          }
        }
      }
    }
  }

  // DDP methods typed in ServerMethods, implemented with Meteor.methods in the server.
  for (const f of snapshot.files.filter((f) => f.repo === "main" && (f.lang === "ts" || f.lang === "tsx"))) {
    const src = text(f.path);
    if (!src.includes("interface ServerMethods")) continue;
    for (const block of src.matchAll(/interface ServerMethods\s*\{([\s\S]*?)\n\t?\}/g)) {
      for (const m of (block[1] ?? "").matchAll(/^\s*'?([A-Za-z][\w:./-]*)'?\??\s*[(<:]/gm)) {
        const name = m[1] ?? "";
        add({ key: `ddp:call:${name}@${SERVER}`, kind: "ddp", name, component: SERVER, source: `main:${f.path}:${lineAt(src, block.index)}`, note: "ServerMethods" });
      }
    }
  }
  // DDP methods the streamer answers itself (login, presence), shadowing the server's.
  for (const f of files("ee/apps/ddp-streamer/src/methods/")) {
    const src = text(f.path);
    for (const block of src.matchAll(/server\.methods\(\{([\s\S]*?)\n\t\}\);/g)) {
      for (const m of (block[1] ?? "").matchAll(/^\t{2}(?:async\s+)?'?([A-Za-z][\w:./-]*)'?\s*\(/gm)) {
        const name = m[1] ?? "";
        add({ key: `ddp:call:${name}@${STREAMER}`, kind: "ddp", name, component: STREAMER, source: `main:${f.path}:${lineAt(src, block.index)}`, note: "ddp-streamer" });
      }
    }
  }
  // DDP streams (StreamerEvents), served by the streamer behind the gateway.
  {
    const path = "packages/ddp-client/src/types/streams.ts";
    const src = text(path);
    for (const m of src.matchAll(/^\t'([\w-]+)':\s*\[/gm)) {
      const name = m[1] ?? "";
      add({ key: `ddp:sub:${name}@${STREAMER}`, kind: "ddp", name, component: STREAMER, source: `main:${path}:${lineAt(src, m.index)}`, note: "stream" });
    }
  }

  // Broker actions: proxify<IPresence>('presence') + the methods of IPresence.
  const namespaces = new Map<string, string>();
  for (const m of text("packages/core-services/src/index.ts").matchAll(/^export const \w+ = proxify<(\w+)>\('([\w-]+)'\)/gm)) {
    namespaces.set(m[1] ?? "", m[2] ?? "");
  }
  for (const f of files("packages/core-services/src/")) {
    const src = text(f.path);
    for (const block of src.matchAll(/export interface (I\w+)(?:<[^>{]*>)?(?:\s+extends\s+[^{]+)?\s*\{([\s\S]*?)\n\}/g)) {
      const ns = namespaces.get(block[1] ?? "");
      if (ns === undefined) continue;
      const host = SERVICE_HOSTS[ns] ?? SERVER;
      for (const m of (block[2] ?? "").matchAll(/^\t(\w+)\??(?:\s*[(<]|:\s*\()/gm)) {
        const name = `${ns}.${m[1] ?? ""}`;
        add({ key: `action:-:${name}@${host}`, kind: "action", name, component: host, source: `main:${f.path}:${lineAt(src, block.index)}`, note: block[1] ?? null });
      }
    }
  }
  // Broker events typed in EventSignatures.
  {
    const path = "packages/core-services/src/events/Events.ts";
    const src = text(path);
    for (const m of src.matchAll(/^\t'([\w.:/-]+)'\s*[(<]/gm)) {
      const name = m[1] ?? "";
      add({ key: `event:-:${name}@*`, kind: "event", name, component: "*", source: `main:${path}:${lineAt(src, m.index)}`, note: "EventSignatures" });
    }
  }

  // MongoDB collections: model classes `super(db, 'room')`, prefixed rocketchat_ unless the
  // class keeps the name as is; the note names the model proxy used in code (Rooms).
  const proxyOf = new Map<string, string>();
  for (const m of text("packages/models/src/index.ts").matchAll(/^export const (\w+) = proxify<(\w+)>/gm)) {
    proxyOf.set(m[2] ?? "", m[1] ?? "");
  }
  const interfaceOf = new Map<string, string>();
  for (const f of snapshot.files.filter((f) => f.repo === "main" && (f.lang === "ts" || f.lang === "tsx"))) {
    const src = text(f.path);
    if (!src.includes("registerModel(")) continue;
    for (const m of src.matchAll(/registerModel\(\s*'(\w+)',\s*(?:\(\)\s*=>\s*)?new (\w+)\(/g)) interfaceOf.set(m[2] ?? "", m[1] ?? "");
  }
  for (const f of [...files("packages/models/src/models/"), ...files("apps/meteor/ee/server/models/raw/"), ...files("apps/meteor/server/models/")]) {
    const src = text(f.path);
    const cls = /export class (\w+) extends BaseRaw/.exec(src)?.[1];
    const base = /super\(\s*db,\s*'(\w+)'/.exec(src);
    if (!cls || !base?.[1]) continue;
    const name = /collectionNameResolver\s*\(\s*name\s*\)\s*\{\s*return name;/.test(src) ? base[1] : `rocketchat_${base[1]}`;
    const proxy = proxyOf.get(interfaceOf.get(cls) ?? "");
    add({ key: `coll:-:${name}@mongo`, kind: "coll", name, component: "mongo", source: `main:${f.path}:${lineAt(src, base.index)}`, note: proxy ? `${proxy} (${cls})` : cls });
  }

  // Cron jobs registered with a literal name.
  for (const f of snapshot.files.filter((f) => f.repo === "main" && (f.lang === "ts" || f.lang === "js"))) {
    const src = text(f.path);
    if (!src.includes("cronJobs.add")) continue;
    for (const m of src.matchAll(/cronJobs\.add\(\s*'([^']+)'/g)) {
      const name = m[1] ?? "";
      const host = f.component ?? SERVER;
      add({ key: `timer:-:${name}@${host}`, kind: "timer", name, component: host, source: `main:${f.path}:${lineAt(src, m.index)}`, note: "cronJobs" });
    }
  }

  return [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** HTTP verbs of the handler object following `API.v1.addRoute(name, options, {` up to the next route. */
function addRouteVerbs(src: string, from: number): string[] {
  const next = src.indexOf("API.v1.", from);
  const body = src.slice(from, next === -1 ? undefined : next);
  const verbs = new Set<string>();
  for (const m of body.matchAll(/^\t{2}(?:async\s+)?(get|post|put|delete)\s*[(:]/gm)) verbs.add((m[1] ?? "").toUpperCase());
  return [...verbs].sort();
}

function lineAt(src: string, offset: number): number {
  let n = 1;
  for (let i = src.indexOf("\n"); i !== -1 && i < offset; i = src.indexOf("\n", i + 1)) n++;
  return n;
}
