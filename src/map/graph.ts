import type { TargetConfig } from "../config/schema.js";
import { parseTargetKey } from "../core/keys.js";
import type { CallSite } from "../core/types.js";
import type { StoredLink } from "../match/run.js";

/** Kinds of relations on the map: the interaction types, with broker actions as `rpc` and events apart, and a gateway's routing rules as `route`. */
export type RelationKind = "http" | "ddp" | "rpc" | "event" | "db" | "trigger" | "route";

/** Where a gateway sends requests: its routing rules grouped by the part they reach. */
export interface GatewayRoute {
  gateway: string;
  target: string;
  paths: string[];
  /** Where the rules are written, e.g. `main:docker-compose-ci.yml:2`. */
  sources: string[];
}

export interface MapElement {
  /** LikeC4 name, unique among its siblings. */
  name: string;
  /** Full id: `parent.name` for nested elements. */
  id: string;
  kind: "client" | "service" | "gateway" | "bus" | "database" | "collection" | "scheduler" | "external" | "endpointGroup";
  title: string;
  /** What the element holds and which parts call it, shown when the element is hovered. */
  description?: string;
  parent: string | null;
  tags: string[];
  metadata: Record<string, string>;
}

export interface MapRelation {
  source: string;
  target: string;
  kind: RelationKind;
  title: string;
  /** Every route, method or name behind the relation, up to a limit. */
  description?: string;
  tags: string[];
  metadata: Record<string, string>;
  /** Target keys behind the relation. */
  keys: string[];
  sites: string[];
}

export interface MapGraph {
  elements: MapElement[];
  relations: MapRelation[];
}

const KIND_OF_KEY: Record<string, RelationKind> = { http: "http", ddp: "ddp", action: "rpc", event: "event", coll: "db", timer: "trigger" };

/** A LikeC4 identifier: letters, digits, `_` and `-`, starting with a letter. */
export function ident(text: string): string {
  const s = text.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Za-z]/.test(s) ? s : `x_${s}`;
}

/** Group of an HTTP route on the map: the first word after the router prefix (`/api/v1/rooms.info` → `rooms`). */
export function routeGroup(template: string): string {
  const rest = template.replace(/^\/api(?:\/v\d+|\/experimental)?\//, "").replace(/^\/+/, "");
  return rest.split(/[./]/)[0] || "root";
}

/**
 * The map of one run: the parts of the system, endpoint groups, broker
 * namespaces and collections nested in them, and the links aggregated by
 * (source part, target element, kind). An ambiguous site draws a relation to
 * each part still possible, tagged `#ambiguous`; an unresolved site draws
 * nothing. No code text reaches the map: titles name routes and counts, and
 * metadata holds cases, one call site and the run. A gateway's routing rules
 * draw a relation from the gateway to each part it sends requests to.
 */
export function buildGraph(config: TargetConfig, run: string, sites: CallSite[], links: StoredLink[], routing: GatewayRoute[] = []): MapGraph {
  const elements = new Map<string, MapElement>();
  const put = (e: Omit<MapElement, "id" | "tags" | "metadata"> & { tags?: string[]; metadata?: Record<string, string> }) => {
    const id = e.parent ? `${e.parent}.${e.name}` : e.name;
    if (!elements.has(id)) elements.set(id, { ...e, id, tags: e.tags ?? [], metadata: e.metadata ?? {} });
    return elements.get(id) as MapElement;
  };
  for (const c of config.components) put({ name: ident(c.id), kind: c.kind, title: c.id, parent: null });
  const bus = config.components.find((c) => c.kind === "bus");
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const relations = new Map<string, MapRelation & { cases: Set<number>; provenance: Set<string>; via: boolean; ambiguous: boolean; names: Set<string> }>();
  const collectionUsers = new Map<string, Set<string>>();

  const targetOf = (key: string, role: string): { element: string; reverse: boolean; name: string } | null => {
    const k = parseTargetKey(key);
    if ("error" in k) return null;
    switch (k.kind) {
      case "http": {
        const parent = ident(k.component);
        const group = routeGroup(k.name);
        put({ name: `ep_${ident(group)}`, kind: "endpointGroup", title: `${k.name.slice(0, k.name.indexOf(group))}${group}…`, parent });
        return { element: `${parent}.ep_${ident(group)}`, reverse: false, name: `${k.method} ${k.name}` };
      }
      case "ddp": {
        const parent = ident(k.component);
        const sub = k.method === "sub";
        put({ name: sub ? "ddp_streams" : "ddp_methods", kind: "endpointGroup", title: sub ? "DDP subscriptions" : "DDP methods", parent });
        return { element: `${parent}.${sub ? "ddp_streams" : "ddp_methods"}`, reverse: false, name: k.name };
      }
      case "action": {
        const parent = ident(k.component);
        const ns = k.name.split(".")[0] ?? k.name;
        put({ name: `ns_${ident(ns)}`, kind: "endpointGroup", title: `${ns}.*`, parent });
        return { element: `${parent}.ns_${ident(ns)}`, reverse: false, name: k.name };
      }
      case "event": {
        const element = bus ? ident(bus.id) : put({ name: "events", kind: "bus", title: "Events", parent: null }).id;
        // a subscription receives from the bus
        return { element, reverse: role === "subscribe", name: k.name };
      }
      case "coll": {
        const parent = ident(k.component);
        put({ name: ident(k.name), kind: "collection", title: k.name, parent });
        return { element: `${parent}.${ident(k.name)}`, reverse: false, name: k.name };
      }
      case "timer": {
        const element = put({ name: "scheduler", kind: "scheduler", title: "Scheduled jobs", parent: null }).id;
        // the scheduler triggers the job in the part that registers it
        return { element, reverse: true, name: k.name };
      }
    }
  };

  for (const l of links) {
    if (l.status !== "linked" && l.status !== "ambiguous") continue;
    const site = siteById.get(l.site);
    if (!site || site.components.length === 0) continue;
    const keys = l.status === "linked" ? (l.alternatives.length > 0 ? l.alternatives : [l.target as string]) : l.alternatives;
    for (const key of keys) {
      const t = targetOf(key, site.role);
      if (!t) continue;
      const kind = KIND_OF_KEY[key.split(":")[0] ?? ""] as RelationKind;
      for (const from of site.components) {
        const source = ident(from);
        if (!elements.has(source)) continue;
        if (kind === "db") collectionUsers.set(t.element, (collectionUsers.get(t.element) ?? new Set()).add(source));
        const [a, b] = t.reverse ? [t.element, source] : [source, t.element];
        if (a === b || b.startsWith(`${a}.`) || a.startsWith(`${b}.`)) continue;
        const id = `${a}|${b}|${kind}`;
        const r =
          relations.get(id) ??
          ({ source: a, target: b, kind, title: "", tags: [], metadata: {}, keys: [], sites: [], cases: new Set(), provenance: new Set(), via: false, ambiguous: false, names: new Set() } as MapRelation & {
            cases: Set<number>;
            provenance: Set<string>;
            via: boolean;
            ambiguous: boolean;
            names: Set<string>;
          });
        if (!r.keys.includes(key)) r.keys.push(key);
        if (!r.sites.includes(site.id)) r.sites.push(site.id);
        if (l.caseNo !== null) r.cases.add(l.caseNo);
        if (l.provenance) r.provenance.add(l.provenance);
        r.via ||= l.via.length > 0;
        r.ambiguous ||= l.status === "ambiguous";
        r.names.add(t.name);
        relations.set(id, r);
      }
    }
  }

  for (const [element, users] of collectionUsers) if (users.size >= 2) elements.get(element)?.tags.push("shared");
  const out: MapRelation[] = [...relations.values()].map((r) => {
    const names = [...r.names].sort();
    const tags = [...[...r.provenance].sort(), ...(r.ambiguous ? ["ambiguous"] : []), ...(r.via ? ["viaGateway"] : [])];
    return {
      source: r.source,
      target: r.target,
      kind: r.kind,
      title: names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} (+${names.length - 2})`,
      description: `${listed(names, 12)}. Decided by ${[...r.provenance].sort().join(", ") || "–"}; ${r.sites.length} call site${r.sites.length === 1 ? "" : "s"}.`,
      tags,
      metadata: { case: [...r.cases].sort((x, y) => x - y).join(","), callsite: r.sites[0] ?? "", sites: String(r.sites.length), run },
      keys: r.keys.sort(),
      sites: r.sites.sort(),
    };
  });
  for (const g of routing) {
    const [source, target] = [ident(g.gateway), ident(g.target)];
    if (!elements.has(source) || !elements.has(target) || source === target) continue;
    const paths = [...g.paths].sort();
    out.push({
      source,
      target,
      kind: "route",
      title: paths.length <= 2 ? paths.join(", ") : `${paths.slice(0, 2).join(", ")} (+${paths.length - 2})`,
      description: `Requests to ${listed(paths, 12)} go to ${g.target}. Rules in ${[...new Set(g.sources)].sort().join(", ")}.`,
      tags: ["infra"],
      metadata: { run },
      keys: [],
      sites: [],
    });
  }
  out.sort((a, b) => (a.source + a.target + a.kind < b.source + b.target + b.kind ? -1 : 1));
  const list = [...elements.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  describeElements(list, out);
  return { elements: list, relations: out };
}

/** Names joined with commas, the rest counted: `a, b (+3 more)`. */
function listed(names: string[], limit: number): string {
  return names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} (+${names.length - limit} more)`;
}

const KIND_LABEL: Record<MapElement["kind"], string> = {
  client: "Client",
  service: "Service",
  gateway: "Gateway",
  bus: "Message bus",
  database: "Database",
  collection: "Collection",
  scheduler: "Scheduled jobs",
  external: "External system",
  endpointGroup: "Endpoint group",
};

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Descriptions a developer sees when hovering an element: for a part, what it
 * holds and which parts call it and which it calls; for an element inside a
 * part, the routes, methods or names the system uses there.
 */
function describeElements(elements: MapElement[], relations: MapRelation[]): void {
  const top = (id: string) => id.split(".")[0] as string;
  for (const e of elements) {
    if (e.parent === null) {
      const inside = elements.filter((c) => c.parent === e.id);
      const held = [
        ...(inside.some((c) => c.name.startsWith("ep_")) ? [count(inside.filter((c) => c.name.startsWith("ep_")).length, "REST endpoint group")] : []),
        ...inside.filter((c) => c.name.startsWith("ddp_")).map((c) => c.title),
        ...(inside.some((c) => c.name.startsWith("ns_")) ? [count(inside.filter((c) => c.name.startsWith("ns_")).length, "broker namespace")] : []),
        ...(inside.some((c) => c.kind === "collection")
          ? [`${count(inside.filter((c) => c.kind === "collection").length, "collection")}, ${inside.filter((c) => c.kind === "collection" && c.tags.includes("shared")).length} shared`]
          : []),
      ];
      const incoming = relations.filter((r) => top(r.target) === e.id && top(r.source) !== e.id);
      const outgoing = relations.filter((r) => top(r.source) === e.id && top(r.target) !== e.id);
      const parts = (rs: MapRelation[], end: "source" | "target") => [...new Set(rs.map((r) => top(r[end])))].sort();
      // events go publisher → bus → subscriber, and jobs scheduler → the part that runs them
      const said: Array<[string, string[]]> =
        e.kind === "bus"
          ? [
              ["Events from", parts(incoming, "source")],
              ["Delivered to", parts(outgoing, "target")],
            ]
          : e.kind === "scheduler"
            ? [["Runs jobs in", parts(outgoing, "target")]]
            : e.kind === "gateway"
              ? outgoing.filter((r) => r.kind === "route").map((r): [string, string[]] => [`Routes ${r.title} to`, [top(r.target)]])
              : [
                ["Used by", parts(incoming.filter((r) => r.kind !== "event" && r.kind !== "trigger" && r.kind !== "route"), "source")],
                ["Receives requests through", parts(incoming.filter((r) => r.kind === "route"), "source")],
                ["Uses", parts(outgoing.filter((r) => r.kind !== "event"), "target")],
                ["Publishes events to", parts(outgoing.filter((r) => r.kind === "event"), "target")],
                ["Receives events from", parts(incoming.filter((r) => r.kind === "event"), "source")],
                ["Runs scheduled jobs from", parts(incoming.filter((r) => r.kind === "trigger"), "source")],
              ];
      e.description = [
        `${KIND_LABEL[e.kind]}${held.length > 0 ? ` with ${held.join(", ")}` : ""}.`,
        ...said.filter(([, names]) => names.length > 0).map(([verb, names]) => `${verb} ${listed(names, 6)}.`),
      ].join(" ");
    } else {
      const names = [...new Set(relations.filter((r) => r.target === e.id || r.source === e.id).flatMap((r) => r.keys.map(displayKey)))].sort();
      const users = [...new Set(relations.filter((r) => r.target === e.id).map((r) => top(r.source)))].sort();
      e.description = [`${KIND_LABEL[e.kind]}: ${listed(names, 12)}.`, ...(users.length > 0 ? [`Used by ${listed(users, 6)}.`] : [])].join(" ");
    }
  }
}

/** A target key as a developer reads it: `GET /api/v1/rooms.info`, `sendMessage`, `users`. */
function displayKey(key: string): string {
  const k = parseTargetKey(key);
  if ("error" in k) return key;
  return k.kind === "http" ? `${k.method} ${k.name}` : k.name;
}
