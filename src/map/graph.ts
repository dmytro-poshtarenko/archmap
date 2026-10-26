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

/** A call the method recognised as going outside the system, with the URL it reaches. */
export interface ExternalCall {
  site: string;
  url: string;
  components: string[];
}

/** What the map adds to the links: the gateways' rules, the calls leaving the system, the product's name. */
export interface MapExtras {
  routing?: GatewayRoute[];
  externals?: ExternalCall[];
  /** The name the map gives the whole system, e.g. `Rocket.Chat`. */
  product?: string;
  /** The protocol of each bus and database part, e.g. `nats` → `NATS`, `mongo` → `MongoDB`. */
  protocols?: Record<string, string>;
}

/** Tag of the relations the C2 view draws: one per pair of containers, standing for every call between them. */
export const OVERVIEW = "overview";

/** Id of the element standing for the whole system on the C1 view. */
export const SYSTEM = "system";

export interface MapElement {
  /** LikeC4 name, unique among its siblings. */
  name: string;
  /** Full id: `parent.name` for nested elements. */
  id: string;
  kind: "system" | "client" | "service" | "gateway" | "bus" | "database" | "collection" | "scheduler" | "external" | "endpointGroup";
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
  /** The protocol the data travels by, shown on the arrow: `HTTP`, `WebSocket (DDP)`, `NATS (events)`, `MongoDB`. */
  technology?: string;
  /** One arrow for calls in both directions: it gets a head at each end. */
  bothWays?: boolean;
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
 * draw a relation from the gateway to each part it sends requests to. Calls
 * leaving the system go to one external element per domain, and the whole
 * system is one more element, for the C1 view.
 */
export function buildGraph(config: TargetConfig, run: string, sites: CallSite[], links: StoredLink[], extras: MapExtras = {}): MapGraph {
  const routing = extras.routing ?? [];
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
  out.push(...externalRelations(extras.externals ?? [], put, elements, run));
  if (!elements.has(SYSTEM)) {
    put({ name: SYSTEM, kind: "system", title: extras.product ?? config.name, parent: null });
    out.push(...systemRelations(out, elements, run));
  }
  const busProtocol = config.components.filter((c) => c.kind === "bus").map((c) => extras.protocols?.[c.id])[0];
  for (const r of out) r.technology ??= technologyOf(r, extras.protocols ?? {}, busProtocol);
  out.sort((a, b) => (a.source + a.target + a.kind < b.source + b.target + b.kind ? -1 : 1));
  const list = [...elements.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  describeElements(list, out);
  out.push(...overviewRelations(out, elements, run));
  return { elements: list, relations: out };
}

/** The protocol of a relation, from its kind and the protocols of the bus and the database it reaches. */
function technologyOf(r: MapRelation, protocols: Record<string, string>, busProtocol: string | undefined): string {
  const top = (id: string) => id.split(".")[0] as string;
  switch (r.kind) {
    case "http":
      return "HTTP";
    case "ddp":
      return "WebSocket (DDP)";
    case "rpc":
      return busProtocol ? `${busProtocol} (RPC)` : "RPC";
    case "event":
      return `${protocols[top(r.target)] ?? protocols[top(r.source)] ?? busProtocol ?? "broker"} (events)`;
    case "db":
      return protocols[top(r.target)] ?? "database";
    case "trigger":
      return "schedule";
    case "route":
      return /websocket|sockjs/i.test(r.title) ? "HTTP, WebSocket" : "HTTP";
  }
}

/** Order of the kinds when one arrow stands for several: its colour and line come from the first. */
const PRIORITY: RelationKind[] = ["http", "ddp", "rpc", "event", "db", "trigger", "route"];

/**
 * The relations of the C2 view: one per pair of containers, standing for
 * every call between them and naming its protocols. Broker actions and
 * events that go both ways become one arrow with a head at each end, drawn
 * from a service towards the bus.
 */
function overviewRelations(relations: MapRelation[], elements: Map<string, MapElement>, run: string): MapRelation[] {
  const top = (id: string) => id.split(".")[0] as string;
  const pairs = new Map<string, MapRelation[]>();
  for (const r of relations) {
    const [a, b] = [top(r.source), top(r.target)];
    if (a === b || a === SYSTEM) continue;
    pairs.set(`${a}|${b}`, [...(pairs.get(`${a}|${b}`) ?? []), r]);
  }
  const out: MapRelation[] = [];
  const done = new Set<string>();
  for (const [key, there] of pairs) {
    if (done.has(key)) continue;
    const [a, b] = key.split("|") as [string, string];
    const back = pairs.get(`${b}|${a}`) ?? [];
    const bothWays = back.length > 0 && [...there, ...back].every((r) => r.kind === "rpc" || r.kind === "event");
    done.add(key);
    if (bothWays) done.add(`${b}|${a}`);
    const all = bothWays ? [...there, ...back] : there;
    const sites = (rs: MapRelation[]) => new Set(rs.flatMap((r) => r.sites)).size;
    // a two-headed arrow starts at the service, not the bus, or at the side that calls more
    const flip = bothWays && (elements.get(a)?.kind === "bus" || (elements.get(b)?.kind !== "bus" && sites(back) > sites(there)));
    const [source, target] = flip ? [b, a] : [a, b];
    const kinds = PRIORITY.filter((k) => all.some((r) => r.kind === k));
    const summary = kinds.map((k) => summaryOf(k, all.filter((r) => r.kind === k), elements));
    const technologies = [...new Set(kinds.flatMap((k) => all.filter((r) => r.kind === k).map((r) => r.technology ?? "")))].filter(Boolean);
    const provenance = [...new Set(all.flatMap((r) => r.tags.filter((t) => t === "rules" || t === "infra" || t === "llm")))].sort();
    out.push({
      source,
      target,
      kind: kinds[0] as RelationKind,
      title: `${summary.map((x) => x.title).join("; ")}${bothWays ? " (both ways)" : ""}`,
      description: `${summary.map((x) => x.detail).join(" ")} ${sites(all)} call site${sites(all) === 1 ? "" : "s"}.`.trim(),
      technology: technologies.join(", "),
      bothWays,
      tags: [OVERVIEW, ...provenance, ...(all.some((r) => r.tags.includes("viaGateway")) ? ["viaGateway"] : [])],
      metadata: { sites: String(sites(all)), run },
      keys: [],
      sites: [...new Set(all.flatMap((r) => r.sites))].sort(),
    });
  }
  return out;
}

/** What one kind of call between two containers amounts to: a short title and the names behind it. */
function summaryOf(kind: RelationKind, rs: MapRelation[], elements: Map<string, MapElement>): { title: string; detail: string } {
  const names = [...new Set(rs.flatMap((r) => (r.keys.length > 0 ? r.keys.map(displayKey) : [r.title])))].sort();
  const n = names.length;
  const external = rs.every((r) => elements.get(r.target)?.kind === "external");
  const endpoints = rs.reduce((sum, r) => sum + Number(r.metadata.endpoints ?? 1), 0);
  switch (kind) {
    case "http":
      return external
        ? { title: count(endpoints, "endpoint"), detail: `${listed(rs.map((r) => r.description?.split(". ")[0] ?? r.title), 12)}.` }
        : { title: `REST: ${count(n, "route")}`, detail: `REST: ${listed(names, 12)}.` };
    case "ddp": {
      const subs = rs.flatMap((r) => r.keys).filter((k) => k.startsWith("ddp:sub:")).length;
      const methods = rs.flatMap((r) => r.keys).filter((k) => k.startsWith("ddp:call:")).length;
      return { title: `DDP: ${[methods > 0 ? count(methods, "method") : "", subs > 0 ? count(subs, "subscription") : ""].filter(Boolean).join(", ")}`, detail: `DDP: ${listed(names, 12)}.` };
    }
    case "rpc":
      return { title: `RPC: ${count(n, "action")}`, detail: `Broker actions: ${listed(names, 12)}.` };
    case "event":
      return { title: `events: ${n}`, detail: `Events: ${listed(names, 12)}.` };
    case "db":
      return { title: count(n, "collection"), detail: `Collections: ${listed(names, 12)}.` };
    case "trigger":
      return { title: count(n, "scheduled job"), detail: `Jobs: ${listed(names, 12)}.` };
    case "route":
      return { title: `routes ${rs.map((r) => r.title).join(", ")}`, detail: `${rs.map((r) => r.description ?? "").join(" ")}` };
  }
}

/** The organisation a host belongs to, as its last two labels: `translation.googleapis.com` → `googleapis.com`. */
export function domainOf(host: string): string {
  return host.split(".").slice(-2).join(".");
}

type Put = (e: Omit<MapElement, "id" | "tags" | "metadata"> & { tags?: string[]; metadata?: Record<string, string> }) => MapElement;

/** Relations from the calling parts to one external element per domain. */
function externalRelations(calls: ExternalCall[], put: Put, elements: Map<string, MapElement>, run: string): MapRelation[] {
  const relations = new Map<string, MapRelation & { names: Set<string>; schemes: Set<string> }>();
  for (const call of calls) {
    let url: URL;
    try {
      url = new URL(call.url);
    } catch {
      continue;
    }
    const domain = domainOf(url.hostname);
    const ext = put({ name: `ext_${ident(domain)}`, kind: "external", title: domain, parent: null });
    ext.metadata.hosts = [...new Set([...(ext.metadata.hosts ?? "").split(", ").filter(Boolean), url.hostname])].sort().join(", ");
    for (const from of call.components) {
      const source = ident(from);
      if (!elements.has(source)) continue;
      const id = `${source}|${ext.id}`;
      const r = relations.get(id) ?? { source, target: ext.id, kind: "http" as const, title: "", tags: [], metadata: {}, keys: [], sites: [], names: new Set<string>(), schemes: new Set<string>() };
      r.names.add(`${url.hostname}${url.pathname}`);
      r.schemes.add(url.protocol === "https:" ? "HTTPS" : "HTTP");
      if (!r.sites.includes(call.site)) r.sites.push(call.site);
      relations.set(id, r);
    }
  }
  return [...relations.values()].map(({ names, schemes, ...r }) => {
    const sorted = [...names].sort();
    return {
      ...r,
      technology: [...schemes].sort().join(", "),
      title: sorted.length <= 2 ? sorted.join(", ") : `${sorted.slice(0, 2).join(", ")} (+${sorted.length - 2})`,
      description: `${listed(sorted, 12)}. Outside the system; ${r.sites.length} call site${r.sites.length === 1 ? "" : "s"}.`,
      metadata: { callsite: r.sites.sort()[0] ?? "", sites: String(r.sites.length), endpoints: String(sorted.length), run },
    };
  });
}

/** For the C1 view: the whole system calls each external element its parts call. */
function systemRelations(relations: MapRelation[], elements: Map<string, MapElement>, run: string): MapRelation[] {
  const byTarget = new Map<string, MapRelation[]>();
  for (const r of relations) if (elements.get(r.target)?.kind === "external" && r.source !== SYSTEM) byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), r]);
  return [...byTarget].map(([target, rs]) => {
    const sites = [...new Set(rs.flatMap((r) => r.sites))].sort();
    const callers = [...new Set(rs.map((r) => r.source))].sort();
    const hosts = elements.get(target)?.metadata.hosts ?? "";
    return {
      source: SYSTEM,
      target,
      kind: "http" as const,
      title: `${hosts.split(", ").slice(0, 2).join(", ")}${hosts.split(", ").length > 2 ? " …" : ""} (${sites.length} call${sites.length === 1 ? "" : "s"})`,
      description: `Called from ${listed(callers, 6)}. Hosts: ${hosts}.`,
      technology: [...new Set(rs.map((r) => r.technology ?? "HTTP"))].sort().join(", "),
      tags: [],
      metadata: { sites: String(sites.length), run },
      keys: [],
      sites,
    };
  });
}

/** Names joined with commas, the rest counted: `a, b (+3 more)`. */
function listed(names: string[], limit: number): string {
  return names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} (+${names.length - limit} more)`;
}

const KIND_LABEL: Record<MapElement["kind"], string> = {
  system: "Software system",
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
      const external = (id: string) => elements.find((x) => x.id === id)?.kind === "external";
      const titled = (ids: string[]) => ids.map((id) => elements.find((x) => x.id === id)?.title ?? id);
      const said = sentences(e, elements, { incoming, outgoing, parts, external, titled });
      const hosts = e.kind === "external" && e.metadata.hosts ? ` (${e.metadata.hosts})` : "";
      e.description = [
        `${KIND_LABEL[e.kind]}${hosts}${held.length > 0 ? ` with ${held.join(", ")}` : ""}.`,
        ...said.filter(([, names]) => names === null || names.length > 0).map(([verb, names]) => (names === null ? `${verb}.` : `${verb} ${listed(names, 6)}.`)),
      ].join(" ");
    } else {
      const names = [...new Set(relations.filter((r) => r.target === e.id || r.source === e.id).flatMap((r) => r.keys.map(displayKey)))].sort();
      const users = [...new Set(relations.filter((r) => r.target === e.id).map((r) => top(r.source)))].sort();
      e.description = [`${KIND_LABEL[e.kind]}: ${listed(names, 12)}.`, ...(users.length > 0 ? [`Used by ${listed(users, 6)}.`] : [])].join(" ");
    }
  }
}

interface Ends {
  incoming: MapRelation[];
  outgoing: MapRelation[];
  parts: (rs: MapRelation[], end: "source" | "target") => string[];
  external: (id: string) => boolean;
  titled: (ids: string[]) => string[];
}

/**
 * Who a top-level element talks to, as (verb, names) pairs: events go
 * publisher → bus → subscriber, jobs scheduler → the part that runs them,
 * requests gateway → the part its rules name.
 */
function sentences(e: MapElement, elements: MapElement[], { incoming, outgoing, parts, external, titled }: Ends): Array<[string, string[] | null]> {
  switch (e.kind) {
    case "system": {
      const containers = elements.filter((c) => c.parent === null && c.kind !== "system" && c.kind !== "external").length;
      return [
        [`Its ${containers} containers are on the C2 view`, null],
        ["It calls", titled(parts(outgoing, "target"))],
      ];
    }
    case "external":
      return [["Called by", parts(incoming.filter((r) => r.source !== SYSTEM), "source")]];
    case "bus":
      return [
        ["Events from", parts(incoming, "source")],
        ["Delivered to", parts(outgoing, "target")],
      ];
    case "scheduler":
      return [["Runs jobs in", parts(outgoing, "target")]];
    case "gateway":
      return outgoing.filter((r) => r.kind === "route").map((r): [string, string[] | null] => [`Routes ${r.title} to`, [r.target.split(".")[0] as string]]);
    default:
      return [
        ["Used by", parts(incoming.filter((r) => r.kind !== "event" && r.kind !== "trigger" && r.kind !== "route"), "source")],
        ["Receives requests through", parts(incoming.filter((r) => r.kind === "route"), "source")],
        ["Uses", parts(outgoing.filter((r) => r.kind !== "event" && !external(r.target)), "target")],
        ["Calls outside the system", titled(parts(outgoing.filter((r) => external(r.target)), "target"))],
        ["Publishes events to", parts(outgoing.filter((r) => r.kind === "event"), "target")],
        ["Receives events from", parts(incoming.filter((r) => r.kind === "event"), "source")],
        ["Runs scheduled jobs from", parts(incoming.filter((r) => r.kind === "trigger"), "source")],
      ];
  }
}

/** A target key as a developer reads it: `GET /api/v1/rooms.info`, `sendMessage`, `users`. */
function displayKey(key: string): string {
  const k = parseTargetKey(key);
  if ("error" in k) return key;
  return k.kind === "http" ? `${k.method} ${k.name}` : k.name;
}
