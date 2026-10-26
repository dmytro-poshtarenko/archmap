import type { TargetConfig } from "../config/schema.js";
import { parseTargetKey } from "../core/keys.js";
import type { CallSite } from "../core/types.js";
import type { StoredLink } from "../match/run.js";

/**
 * Kinds of relations on the map:
 * - request and response: `http`, `ddp` (a DDP method), `rpc` (a broker action);
 * - asynchronous: `stream` (a DDP subscription), `event` (a broker event);
 * - data: `db`;
 * - a gateway's routing rules: `route`.
 */
export type RelationKind = "http" | "ddp" | "rpc" | "stream" | "event" | "db" | "route";

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

/** What the map adds to the links: the deployment, the calls leaving the system, names and technologies. */
export interface MapExtras {
  routing?: GatewayRoute[];
  externals?: ExternalCall[];
  /** The name the map gives the whole system, e.g. `Rocket.Chat`. */
  product?: string;
  /** The protocol of each bus and database part, e.g. `nats` → `NATS`, `mongo` → `MongoDB`. */
  protocols?: Record<string, string>;
  /** What each part is built with, e.g. `rocketchat` → `Node.js, Meteor, Moleculer`. */
  technologies?: Record<string, string>;
  /** The parts that run a call site under the run's deployment, as the method narrows them; by default every part that loads its file. */
  componentsOf?: (site: CallSite) => string[];
  /** The package a call site's file belongs to, e.g. `packages/models`. */
  packageOf?: (site: CallSite) => string | null;
}

/** Tag of the relations the C2 views draw: one per direction between two containers, standing for every call between them. */
export const OVERVIEW = "overview";
/** Tag of the relations the gateway views draw: who sends requests through a gateway, and where its rules send them. */
export const GATEWAY = "gateway";
/** Tag of a relation whose every call sits in code several containers bundle: which of them makes the call is not known. */
export const SHARED_CODE = "sharedCode";
/** Tag of a container the method found no links for. */
export const NO_LINKS = "noLinks";

/** Id of the element standing for the whole system on the C1 view. */
export const SYSTEM = "system";

export interface MapElement {
  /** LikeC4 name, unique among its siblings. */
  name: string;
  /** Full id: `parent.name` for nested elements. */
  id: string;
  kind: "system" | "client" | "service" | "gateway" | "bus" | "database" | "collection" | "scheduler" | "jobs" | "external" | "endpointGroup";
  title: string;
  /** One line drawn on the element. */
  summary?: string;
  /** What the element is built with, drawn under its title. */
  technology?: string;
  /** What the element holds and which parts call it, shown in its details. */
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
  /** The protocol the data travels by, shown on the arrow: `HTTP via traefik`, `WebSocket (DDP)`, `NATS (events)`, `MongoDB`. */
  technology?: string;
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

/** The organisation a host belongs to, as its last two labels: `translation.googleapis.com` → `googleapis.com`. */
export function domainOf(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/** A relation being collected: its names with the call sites behind each. */
interface Building {
  source: string;
  target: string;
  kind: RelationKind;
  keys: Set<string>;
  sites: Set<string>;
  names: Map<string, Set<string>>;
  cases: Set<number>;
  provenance: Set<string>;
  via: Set<string>;
  ambiguous: boolean;
  /** Sites some other container also runs: the relation is shared code when every site is one. */
  shared: Set<string>;
  packages: Set<string>;
}

type Put = (e: Omit<MapElement, "id" | "tags" | "metadata"> & { tags?: string[]; metadata?: Record<string, string> }) => MapElement;

/**
 * The map of one run: the parts of the system, the endpoint groups, broker
 * namespaces, collections and scheduled jobs inside them, and the links
 * aggregated by (source part, target element, kind).
 * - An ambiguous site draws a relation to each part still possible, tagged
 *   `#ambiguous`; an unresolved site draws nothing.
 * - A site belongs to the parts that run it under the deployment, as the
 *   method narrows them; code several containers bundle makes `#sharedCode`.
 * - No code text reaches the map: titles name routes and counts, metadata
 *   holds cases, one call site and the run.
 * - A gateway's rules, the calls leaving the system and the whole system as
 *   one element serve the gateway, C1 and C2 views.
 */
export function buildGraph(config: TargetConfig, run: string, sites: CallSite[], links: StoredLink[], extras: MapExtras = {}): MapGraph {
  const elements = new Map<string, MapElement>();
  const put: Put = (e) => {
    const id = e.parent ? `${e.parent}.${e.name}` : e.name;
    if (!elements.has(id)) elements.set(id, { ...e, id, tags: e.tags ?? [], metadata: e.metadata ?? {} });
    return elements.get(id) as MapElement;
  };
  for (const c of config.components) put({ name: ident(c.id), kind: c.kind, title: c.id, parent: null, technology: extras.technologies?.[c.id] });
  const bus = config.components.find((c) => c.kind === "bus");
  const protocols = extras.protocols ?? {};
  const busProtocol = bus ? protocols[bus.id] : undefined;
  const partsOf = extras.componentsOf ?? ((s: CallSite) => s.components);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const building = new Map<string, Building>();
  const jobs = new Map<string, Map<string, Set<string>>>();

  for (const l of links) {
    if (l.status !== "linked" && l.status !== "ambiguous") continue;
    const site = siteById.get(l.site);
    const parts = site ? partsOf(site).filter((p) => elements.has(ident(p))) : [];
    if (!site || parts.length === 0) continue;
    const keys = l.status === "linked" ? (l.alternatives.length > 0 ? l.alternatives : [l.target as string]) : l.alternatives;
    for (const key of keys) {
      const k = parseTargetKey(key);
      if ("error" in k) continue;
      if (k.kind === "timer") {
        // a scheduled job runs inside the part that registers it, not in a container of its own
        for (const p of parts) {
          const owner = ident(p);
          put({ name: "jobs", kind: "jobs", title: "Scheduled jobs", parent: owner, technology: "in-process schedule" });
          const named = jobs.get(owner) ?? new Map<string, Set<string>>();
          named.set(k.name, (named.get(k.name) ?? new Set()).add(site.id));
          jobs.set(owner, named);
        }
        continue;
      }
      const t = targetOf(k, site.role, put, bus?.id);
      if (!t) continue;
      for (const p of parts) {
        const source = ident(p);
        const [a, b] = t.reverse ? [t.element, source] : [source, t.element];
        if (a === b || b.startsWith(`${a}.`) || a.startsWith(`${b}.`)) continue;
        const id = `${a}|${b}|${t.kind}`;
        const r = building.get(id) ?? {
          source: a,
          target: b,
          kind: t.kind,
          keys: new Set<string>(),
          sites: new Set<string>(),
          names: new Map<string, Set<string>>(),
          cases: new Set<number>(),
          provenance: new Set<string>(),
          via: new Set<string>(),
          ambiguous: false,
          shared: new Set<string>(),
          packages: new Set<string>(),
        };
        r.keys.add(key);
        r.sites.add(site.id);
        r.names.set(t.name, (r.names.get(t.name) ?? new Set()).add(site.id));
        if (l.caseNo !== null) r.cases.add(l.caseNo);
        if (l.provenance) r.provenance.add(l.provenance);
        for (const g of l.via) r.via.add(g);
        r.ambiguous ||= l.status === "ambiguous";
        if (parts.length >= 2) {
          r.shared.add(site.id);
          const pkg = extras.packageOf?.(site);
          if (pkg) r.packages.add(pkg);
        }
        building.set(id, r);
      }
    }
  }

  const websocketOf = websocketTargets(extras.routing ?? []);
  const out: MapRelation[] = [...building.values()].map((r) => finish(r, run, protocols, busProtocol, websocketOf, elements));
  for (const r of out) {
    const target = elements.get(r.target);
    if (r.kind === "db" && target?.kind === "collection" && !r.tags.includes(SHARED_CODE)) target.metadata.users = [...new Set([...(target.metadata.users ?? "").split(",").filter(Boolean), r.source.split(".")[0] as string])].join(",");
  }
  for (const e of elements.values()) if (e.kind === "collection" && (e.metadata.users ?? "").split(",").filter(Boolean).length >= 2) e.tags.push("shared");
  for (const e of elements.values()) delete e.metadata.users;
  for (const [owner, named] of jobs) {
    const e = elements.get(`${owner}.jobs`) as MapElement;
    const names = ranked(named);
    e.summary = count(names.length, "job");
    e.description = `Scheduled jobs registered in ${owner}, run in its own process: ${listed(names, 12)}.`;
  }

  out.push(...gatewayRelations(extras.routing ?? [], out, elements, run));
  out.push(...externalRelations(extras.externals ?? [], partsOf, siteById, put, elements, run));
  if (!elements.has(SYSTEM)) {
    put({ name: SYSTEM, kind: "system", title: extras.product ?? config.name, parent: null });
    out.push(...systemRelations(out, elements, run));
  }
  out.sort((a, b) => (a.source + a.target + a.kind < b.source + b.target + b.kind ? -1 : 1));
  const list = [...elements.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  markNoLinks(list, out, sites, links, partsOf);
  describeElements(list, out, protocols);
  out.push(...overviewRelations(out, elements, websocketOf, busProtocol, run));
  return { elements: list, relations: out };
}

/** Where a key points on the map, and the name it adds to the relation's label. */
function targetOf(
  k: Exclude<ReturnType<typeof parseTargetKey>, { error: string }>,
  role: string,
  put: Put,
  bus: string | undefined,
): { element: string; reverse: boolean; name: string; kind: RelationKind } | null {
  switch (k.kind) {
    case "http": {
      const parent = ident(k.component);
      const group = routeGroup(k.name);
      // the label leaves out the prefix the group's box already shows
      const prefix = k.name.slice(0, k.name.indexOf(group));
      put({ name: `ep_${ident(group)}`, kind: "endpointGroup", title: `${prefix}${group}…`, parent, technology: "REST" });
      return { element: `${parent}.ep_${ident(group)}`, reverse: false, name: `${k.method} ${k.name.slice(prefix.length)}`, kind: "http" };
    }
    case "ddp": {
      const parent = ident(k.component);
      const sub = k.method === "sub";
      put({ name: sub ? "ddp_streams" : "ddp_methods", kind: "endpointGroup", title: sub ? "DDP subscriptions" : "DDP methods", parent, technology: "DDP" });
      return { element: `${parent}.${sub ? "ddp_streams" : "ddp_methods"}`, reverse: false, name: k.name, kind: sub ? "stream" : "ddp" };
    }
    case "action": {
      const parent = ident(k.component);
      const ns = k.name.split(".")[0] ?? k.name;
      put({ name: `ns_${ident(ns)}`, kind: "endpointGroup", title: `${ns}.*`, parent, technology: "broker actions" });
      return { element: `${parent}.ns_${ident(ns)}`, reverse: false, name: k.name.slice(ns.length + 1) || k.name, kind: "rpc" };
    }
    case "event": {
      const element = bus ? ident(bus) : put({ name: "events", kind: "bus", title: "Events", parent: null }).id;
      // a subscription receives from the bus
      return { element, reverse: role === "subscribe", name: k.name, kind: "event" };
    }
    case "coll": {
      const parent = ident(k.component);
      put({ name: ident(k.name), kind: "collection", title: k.name, parent });
      return { element: `${parent}.${ident(k.name)}`, reverse: false, name: k.name, kind: "db" };
    }
    default:
      return null;
  }
}

/** The gateways that send WebSocket upgrades (`/websocket`, `/sockjs`) to a part: gateway → that part. */
function websocketTargets(routing: GatewayRoute[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of routing) if (g.paths.some((p) => /websocket|sockjs/i.test(p))) out.set(ident(g.gateway), ident(g.target));
  return out;
}

/** The protocol a relation's data travels by, with the gateway it passes. */
function protocolOf(kind: RelationKind, source: string, target: string, protocols: Record<string, string>, busProtocol: string | undefined): string {
  const top = (id: string) => id.split(".")[0] as string;
  switch (kind) {
    case "http":
      return "HTTP";
    case "ddp":
    case "stream":
      return "WebSocket (DDP)";
    case "rpc":
      return busProtocol ? `${busProtocol} (RPC)` : "RPC";
    case "event":
      return `${protocols[top(target)] ?? protocols[top(source)] ?? busProtocol ?? "broker"} (events)`;
    case "db":
      return protocols[top(target)] ?? "database";
    case "route":
      return "HTTP";
  }
}

/** A collected relation as the map draws it: label, description, protocol and tags. */
function finish(r: Building, run: string, protocols: Record<string, string>, busProtocol: string | undefined, websocketOf: Map<string, string>, elements: Map<string, MapElement>): MapRelation {
  const names = ranked(r.names);
  const sharedCode = r.shared.size === r.sites.size;
  const via = [...r.via].sort();
  // DDP over the WebSocket another part terminates: the label names that part
  const terminator = (r.kind === "ddp" || r.kind === "stream") ? via.map((g) => websocketOf.get(ident(g))).find((w) => w && w !== r.target.split(".")[0]) : undefined;
  const protocol = protocolOf(r.kind, r.source, r.target, protocols, busProtocol);
  const technology = terminator ? `${protocol} through ${terminator}` : via.length > 0 ? `${protocol} via ${via.join(", ")}` : protocol;
  const shared = sharedCode
    ? ` Only shared code links them: every call sits in ${[...r.packages].sort().join(", ") || "code"} that several containers bundle, so which of them makes the call is not known.`
    : "";
  const target = elements.get(r.target);
  return {
    source: r.source,
    target: r.target,
    kind: r.kind,
    // the collection's box already shows its name
    title: r.kind === "db" && target?.kind === "collection" ? "" : head(names, 3),
    description: `${listed(names, 12)}. Decided by ${[...r.provenance].sort().join(", ") || "–"}; ${count(r.sites.size, "call site")}.${shared}`,
    technology,
    tags: [...[...r.provenance].sort(), ...(r.ambiguous ? ["ambiguous"] : []), ...(via.length > 0 ? ["viaGateway"] : []), ...(sharedCode ? [SHARED_CODE] : [])],
    metadata: {
      case: [...r.cases].sort((x, y) => x - y).join(","),
      callsite: [...r.sites].sort()[0] ?? "",
      sites: String(r.sites.size),
      via: via.join(","),
      through: terminator ?? "",
      run,
    },
    keys: [...r.keys].sort(),
    sites: [...r.sites].sort(),
  };
}

/** Names ordered by how many call sites use them, then alphabetically. */
function ranked(names: Map<string, Set<string>>): string[] {
  return [...names].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
}

/** The first names and how many more: `a, b, c +4`. */
function head(names: string[], n: number): string {
  return names.length <= n ? names.join(", ") : `${names.slice(0, n).join(", ")} +${names.length - n}`;
}

/** Names joined with commas, the rest counted: `a, b (+3 more)`. */
function listed(names: string[], limit: number): string {
  return names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} (+${names.length - limit} more)`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * For the gateway views: each gateway's rules as relations to the parts they
 * reach, and from each part whose calls pass the gateway to the gateway.
 */
function gatewayRelations(routing: GatewayRoute[], relations: MapRelation[], elements: Map<string, MapElement>, run: string): MapRelation[] {
  const out: MapRelation[] = [];
  for (const g of routing) {
    const [source, target] = [ident(g.gateway), ident(g.target)];
    if (!elements.has(source) || !elements.has(target) || source === target) continue;
    const paths = [...g.paths].sort();
    out.push({
      source,
      target,
      kind: "route",
      title: head(paths, 3),
      description: `Requests to ${listed(paths, 12)} go to ${g.target}. Rules in ${[...new Set(g.sources)].sort().join(", ")}.`,
      technology: paths.some((p) => /websocket|sockjs/i.test(p)) ? "HTTP, WebSocket" : "HTTP",
      tags: ["infra", GATEWAY],
      metadata: { run },
      keys: [],
      sites: [],
    });
  }
  const callers = new Map<string, MapRelation[]>();
  for (const r of relations) {
    if (!r.tags.includes("viaGateway")) continue;
    for (const g of (r.metadata.via ?? "").split(",").filter(Boolean)) {
      const gateway = ident(g);
      if (elements.get(gateway)?.kind !== "gateway") continue;
      const key = `${r.source.split(".")[0]}|${gateway}`;
      callers.set(key, [...(callers.get(key) ?? []), r]);
    }
  }
  for (const [key, rs] of callers) {
    const [source, gateway] = key.split("|") as [string, string];
    const sites = new Set(rs.flatMap((r) => r.sites));
    const what = [...new Set(rs.map((r) => (r.kind === "http" ? "REST" : r.kind === "ddp" ? "DDP methods" : r.kind === "stream" ? "DDP subscriptions" : r.kind)))];
    out.push({
      source,
      target: gateway,
      kind: rs.some((r) => r.kind === "http") ? "http" : (rs[0] as MapRelation).kind,
      title: what.join(", "),
      description: `${count(sites.size, "call site")} of ${source} reach the system through ${gateway}.`,
      technology: rs.some((r) => r.kind === "ddp" || r.kind === "stream") ? "HTTP, WebSocket" : "HTTP",
      tags: [GATEWAY],
      metadata: { sites: String(sites.size), run },
      keys: [],
      sites: [...sites].sort(),
    });
  }
  return out;
}

/** Relations from the calling parts to one external element per domain. */
function externalRelations(
  calls: ExternalCall[],
  partsOf: (s: CallSite) => string[],
  siteById: Map<string, CallSite>,
  put: Put,
  elements: Map<string, MapElement>,
  run: string,
): MapRelation[] {
  const relations = new Map<string, { source: string; target: string; names: Map<string, Set<string>>; sites: Set<string>; schemes: Set<string> }>();
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
    const site = siteById.get(call.site);
    for (const from of site ? partsOf(site) : call.components) {
      const source = ident(from);
      if (!elements.has(source)) continue;
      const id = `${source}|${ext.id}`;
      const r = relations.get(id) ?? { source, target: ext.id, names: new Map(), sites: new Set(), schemes: new Set() };
      const name = `${url.hostname}${url.pathname}`;
      r.names.set(name, (r.names.get(name) ?? new Set()).add(call.site));
      r.schemes.add(url.protocol === "https:" ? "HTTPS" : "HTTP");
      r.sites.add(call.site);
      relations.set(id, r);
    }
  }
  return [...relations.values()].map((r) => {
    const names = ranked(r.names);
    return {
      source: r.source,
      target: r.target,
      kind: "http" as const,
      title: head(names, 2),
      description: `${listed(names, 12)}. Outside the system; ${count(r.sites.size, "call site")}.`,
      technology: [...r.schemes].sort().join(", "),
      tags: [],
      metadata: { callsite: [...r.sites].sort()[0] ?? "", sites: String(r.sites.size), run },
      // the endpoints reached, so C2 and C1 count them the same way
      keys: names,
      sites: [...r.sites].sort(),
    };
  });
}

/** For the C1 view: the whole system calls each external element its parts call. */
function systemRelations(relations: MapRelation[], elements: Map<string, MapElement>, run: string): MapRelation[] {
  const byTarget = new Map<string, MapRelation[]>();
  for (const r of relations) if (elements.get(r.target)?.kind === "external" && r.source !== SYSTEM) byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), r]);
  return [...byTarget].map(([target, rs]) => {
    const sites = [...new Set(rs.flatMap((r) => r.sites))].sort();
    const endpoints = new Set(rs.flatMap((r) => r.keys)).size;
    const callers = [...new Set(rs.map((r) => r.source))].sort();
    return {
      source: SYSTEM,
      target,
      kind: "http" as const,
      title: count(endpoints, "endpoint"),
      description: `Called from ${listed(callers, 6)}; ${count(sites.length, "call site")}. Hosts: ${elements.get(target)?.metadata.hosts ?? ""}.`,
      technology: [...new Set(rs.map((r) => r.technology ?? "HTTP"))].sort().join(", "),
      tags: [],
      metadata: { sites: String(sites.length), run },
      keys: [],
      sites,
    };
  });
}

/** Containers the method found no links for get a tag and say so on the diagram, with how many call sites they have. */
function markNoLinks(elements: MapElement[], relations: MapRelation[], sites: CallSite[], links: StoredLink[], partsOf: (s: CallSite) => string[]): void {
  const linkOf = new Map(links.map((l) => [l.site, l]));
  for (const e of elements) {
    if (e.parent !== null || (e.kind !== "client" && e.kind !== "service")) continue;
    if (relations.some((r) => r.source.split(".")[0] === e.id || r.target.split(".")[0] === e.id)) continue;
    // scheduled jobs or API groups inside are findings too
    if (elements.some((c) => c.parent === e.id)) continue;
    const own = sites.filter((s) => partsOf(s).some((p) => ident(p) === e.id));
    const open = own.filter((s) => {
      const status = linkOf.get(s.id)?.status;
      return status === "unresolved" || status === "ambiguous";
    }).length;
    e.tags.push(NO_LINKS);
    e.summary = own.length === 0 ? "No links found: no call sites in its code" : `No links found: ${count(own.length, "call site")}, ${open} unresolved`;
  }
}

const KIND_LABEL: Record<MapElement["kind"], string> = {
  system: "Software system",
  client: "Client application",
  service: "Server-side container",
  gateway: "Gateway",
  bus: "Message bus",
  database: "Database",
  collection: "Collection",
  scheduler: "Scheduler",
  jobs: "Scheduled jobs",
  external: "External system",
  endpointGroup: "Endpoint group",
};

/**
 * Text a developer sees on and behind each element: a one-line summary
 * drawn on it, and in its details what it holds, which parts use it and
 * which it uses; for an element inside a part, the names in use there.
 */
function describeElements(elements: MapElement[], relations: MapRelation[], protocols: Record<string, string>): void {
  const top = (id: string) => id.split(".")[0] as string;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const titled = (ids: string[]) => ids.map((id) => byId.get(id)?.title ?? id);
  // elements inside a part first: the part's summary counts what they hold
  for (const e of [...elements].sort((a, b) => Number(a.parent === null) - Number(b.parent === null))) {
    const incoming = relations.filter((r) => (e.parent === null ? top(r.target) === e.id && top(r.source) !== e.id : r.target === e.id));
    const outgoing = relations.filter((r) => (e.parent === null ? top(r.source) === e.id && top(r.target) !== e.id : r.source === e.id));
    const parts = (rs: MapRelation[], end: "source" | "target") => [...new Set(rs.map((r) => top(r[end])))].sort();
    if (e.parent !== null) {
      const names = [...new Set(relations.filter((r) => r.target === e.id || r.source === e.id).flatMap((r) => r.keys.map(displayKey)))].sort();
      const users = parts(incoming, "source");
      if (e.kind !== "jobs") {
        e.summary ??= e.kind === "collection" ? `Used by ${count(users.length, "container")}` : count(names.length, e.name.startsWith("ep_") ? "route" : e.name.startsWith("ns_") ? "action" : e.name === "ddp_streams" ? "stream" : "method");
        e.technology ??= e.kind === "collection" ? `${protocols[top(e.id)] ?? "database"} collection` : undefined;
        e.description = [`${KIND_LABEL[e.kind]}: ${listed(names, 12)}.`, ...(users.length > 0 ? [`Used by ${listed(users, 6)}.`] : [])].join(" ");
      }
      continue;
    }
    const inside = elements.filter((c) => c.parent === e.id);
    const held = heldBy(inside);
    const external = (id: string) => byId.get(id)?.kind === "external";
    const said: Array<[string, string[]]> =
      e.kind === "system"
        ? [["It calls", titled(parts(outgoing, "target"))]]
        : e.kind === "external"
          ? [["Called by", parts(incoming.filter((r) => r.source !== SYSTEM), "source")]]
          : e.kind === "bus"
            ? [
                ["Events from", parts(incoming, "source")],
                ["Delivered to", parts(outgoing, "target")],
              ]
            : e.kind === "gateway"
              ? outgoing.filter((r) => r.kind === "route").map((r): [string, string[]] => [`Routes ${r.title} to`, [top(r.target)]])
              : [
                  ["Used by", parts(incoming.filter((r) => r.kind !== "event" && !r.tags.includes(GATEWAY)), "source")],
                  ["Receives requests through", parts(incoming.filter((r) => r.kind === "route"), "source")],
                  ["Uses", parts(outgoing.filter((r) => r.kind !== "event" && !external(r.target) && !r.tags.includes(GATEWAY)), "target")],
                  ["Calls outside the system", titled(parts(outgoing.filter((r) => external(r.target)), "target"))],
                  ["Publishes events to", parts(outgoing.filter((r) => r.kind === "event"), "target")],
                  ["Receives events from", parts(incoming.filter((r) => r.kind === "event"), "source")],
                ];
    const hosts = e.kind === "external" && e.metadata.hosts ? ` (${e.metadata.hosts})` : "";
    const containers = elements.filter((c) => c.parent === null && c.kind !== "system" && c.kind !== "external").length;
    e.description = [
      `${KIND_LABEL[e.kind]}${hosts}${held.length > 0 ? ` with ${held.join(", ")}` : ""}.`,
      ...(e.kind === "system" ? [`Its ${containers} containers are on the C2 view.`] : []),
      ...said.filter(([, names]) => names.length > 0).map(([verb, names]) => `${verb} ${listed(names, 6)}.`),
    ].join(" ");
    if (e.summary) continue;
    if (e.kind === "system") e.summary = `${containers} containers; calls ${count(parts(outgoing, "target").length, "external system")}`;
    else if (e.kind === "external") e.summary = head((e.metadata.hosts ?? "").split(", ").filter(Boolean), 2);
    else if (e.kind === "gateway") e.summary = `Routes requests to ${listed(parts(outgoing.filter((r) => r.kind === "route"), "target"), 3)}`;
    else if (e.kind === "bus") e.summary = `Carries events between ${count(new Set([...parts(incoming, "source"), ...parts(outgoing, "target")]).size, "container")}`;
    else if (held.length > 0) e.summary = held.join(", ");
    else {
      const internal = parts(outgoing.filter((r) => !r.tags.includes(GATEWAY) && !external(r.target)), "target");
      const outside = parts(outgoing.filter((r) => external(r.target)), "target").length;
      e.summary = [internal.length > 0 ? `Calls ${listed(internal, 3)}` : "", outside > 0 ? `${count(outside, "external system")}` : ""].filter(Boolean).join("; ");
    }
  }
}

/** What a part holds, counted: REST groups, DDP methods and subscriptions, broker namespaces, collections, scheduled jobs. */
function heldBy(inside: MapElement[]): string[] {
  const n = (pred: (c: MapElement) => boolean) => inside.filter(pred).length;
  const jobs = inside.find((c) => c.kind === "jobs");
  return [
    ...(n((c) => c.name.startsWith("ep_")) > 0 ? [count(n((c) => c.name.startsWith("ep_")), "REST group")] : []),
    ...inside.filter((c) => c.name.startsWith("ddp_")).map((c) => (c.name === "ddp_streams" ? `${c.summary?.replace(/streams?$/, "DDP subscriptions").replace(/^1 DDP subscriptions$/, "1 DDP subscription") ?? c.title}` : `${c.summary?.replace(/methods?$/, "DDP methods").replace(/^1 DDP methods$/, "1 DDP method") ?? c.title}`)),
    ...(n((c) => c.name.startsWith("ns_")) > 0 ? [count(n((c) => c.name.startsWith("ns_")), "broker namespace")] : []),
    ...(n((c) => c.kind === "collection") > 0 ? [`${count(n((c) => c.kind === "collection"), "collection")}, ${n((c) => c.kind === "collection" && c.tags.includes("shared"))} shared`] : []),
    ...(jobs?.summary ? [`${jobs.summary.replace(/jobs?$/, "")}scheduled ${jobs.summary.endsWith("s") ? "jobs" : "job"}`] : []),
  ];
}

/** Order of the kinds when one arrow stands for several: request and response first, then asynchronous, then data. */
const PRIORITY: RelationKind[] = ["http", "ddp", "rpc", "stream", "event", "db"];

/**
 * The relations of the C2 views: one per direction between two containers,
 * standing for every call between them and naming what flows and how.
 * - Events go straight from the publisher to each subscriber, through the
 *   bus's protocol, instead of to and from a bus element.
 * - DDP over a WebSocket that a gateway sends to another container goes to
 *   that container.
 * - Shared-code relations and the gateway's own relations stay out.
 */
function overviewRelations(relations: MapRelation[], elements: Map<string, MapElement>, websocketOf: Map<string, string>, busProtocol: string | undefined, run: string): MapRelation[] {
  const top = (id: string) => id.split(".")[0] as string;
  const kindOf = (id: string) => elements.get(top(id))?.kind;
  type Part = { kind: RelationKind; names: Map<string, Set<string>>; protocol: string; via: string[]; provenance: string[] };
  const pairs = new Map<string, Part[]>();
  const add = (a: string, b: string, part: Part) => {
    if (a !== b) pairs.set(`${a}|${b}`, [...(pairs.get(`${a}|${b}`) ?? []), part]);
  };
  const provenanceOf = (r: MapRelation) => r.tags.filter((t) => t === "rules" || t === "infra" || t === "llm");
  const published = new Map<string, Map<string, Set<string>>>();
  const subscribed = new Map<string, Map<string, Set<string>>>();
  for (const r of relations) {
    if (r.tags.includes(SHARED_CODE) || r.tags.includes(GATEWAY) || r.kind === "route" || r.source === SYSTEM) continue;
    const [a, b] = [top(r.source), top(r.target)];
    if (r.kind === "event") {
      // publisher → bus and bus → subscriber become publisher → subscriber
      const toBus = kindOf(b) === "bus";
      const side = toBus ? published : subscribed;
      for (const k of r.keys) {
        const byPart = side.get(k) ?? new Map<string, Set<string>>();
        byPart.set(toBus ? a : b, new Set([...(byPart.get(toBus ? a : b) ?? []), ...r.sites]));
        side.set(k, byPart);
      }
      continue;
    }
    if (kindOf(a) === "bus" || kindOf(b) === "bus") continue;
    const names = new Map(r.keys.map((k) => [displayKey(k), new Set(r.sites)] as [string, Set<string>]));
    // DDP reaches the container that terminates the gateway's WebSocket, which forwards it
    const through = r.metadata.through ? ident(r.metadata.through) : undefined;
    add(a, through && through !== b ? through : b, {
      kind: r.kind,
      names,
      protocol: (r.technology ?? "").replace(/ (via|through) .*$/, ""),
      via: (r.metadata.via ?? "").split(",").filter(Boolean),
      provenance: provenanceOf(r),
    });
  }
  for (const [key, publishers] of published) {
    for (const [subscriber, subSites] of subscribed.get(key) ?? []) {
      for (const [publisher, pubSites] of publishers) {
        add(publisher, subscriber, { kind: "event", names: new Map([[displayKey(key), new Set([...pubSites, ...subSites])]]), protocol: `${busProtocol ?? "broker"} (events)`, via: [], provenance: [] });
      }
    }
  }
  const out: MapRelation[] = [];
  for (const [key, parts] of pairs) {
    const [source, target] = key.split("|") as [string, string];
    const kinds = PRIORITY.filter((k) => parts.some((p) => p.kind === k));
    const merged = (k: RelationKind) => {
      const m = new Map<string, Set<string>>();
      for (const p of parts.filter((x) => x.kind === k)) for (const [n, s] of p.names) m.set(n, new Set([...(m.get(n) ?? []), ...s]));
      return m;
    };
    const summaries = kinds.map((k) => summaryOf(k, merged(k), elements.get(target)?.kind === "external"));
    const sites = new Set(parts.flatMap((p) => [...p.names.values()].flatMap((s) => [...s])));
    const protocolsUsed = joinProtocols([...new Set(kinds.flatMap((k) => parts.filter((p) => p.kind === k).map((p) => p.protocol)))]);
    const gateways = [...new Set(parts.flatMap((p) => p.via))].sort();
    out.push({
      source,
      target,
      kind: kinds[0] as RelationKind,
      title: summaries.map((x) => x.title).join("; "),
      description: `${summaries.map((x) => x.detail).join(" ")} ${count(sites.size, "call site")}.`,
      technology: `${protocolsUsed.join(", ")}${gateways.length > 0 ? ` via ${gateways.join(", ")}` : ""}`,
      tags: [OVERVIEW, ...[...new Set(parts.flatMap((p) => [...p.provenance]))].sort(), ...(gateways.length > 0 ? ["viaGateway"] : [])],
      metadata: { sites: String(sites.size), run },
      keys: [],
      sites: [...sites].sort(),
    });
  }
  return out;
}

/** The family of a dotted name, `presence.setStatus` → `presence.*`; a name without a dot stands for itself. */
function family(name: string): string {
  return name.includes(".") ? `${name.split(".")[0]}.*` : name;
}

/** Protocols with one base written once: `NATS (RPC)`, `NATS (events)` → `NATS (RPC, events)`. */
function joinProtocols(protocols: string[]): string[] {
  const byBase = new Map<string, string[]>();
  for (const p of protocols) {
    const m = /^(.*?) \((.*)\)$/.exec(p);
    const [base, detail] = m ? [m[1] as string, m[2] as string] : [p, ""];
    byBase.set(base, [...(byBase.get(base) ?? []), ...(detail ? [detail] : [])]);
  }
  return [...byBase].map(([base, details]) => (details.length > 0 ? `${base} (${details.join(", ")})` : base));
}

/** What one kind of call between two containers amounts to: a title that says what, and the names behind it. */
function summaryOf(kind: RelationKind, names: Map<string, Set<string>>, external: boolean): { title: string; detail: string } {
  // groups of names by their first word: REST groups, broker namespaces, event families;
  // the group holding the most names first, then the one with the most call sites
  const grouped = (group: (n: string) => string) => {
    const g = new Map<string, { names: number; sites: Set<string> }>();
    for (const [n, s] of names) {
      const k = group(n);
      const v = g.get(k) ?? { names: 0, sites: new Set<string>() };
      v.names++;
      for (const x of s) v.sites.add(x);
      g.set(k, v);
    }
    return [...g].sort((a, b) => b[1].names - a[1].names || b[1].sites.size - a[1].sites.size || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
  };
  const all = ranked(names);
  switch (kind) {
    case "http": {
      if (external) return { title: count(all.length, "endpoint"), detail: `Endpoints: ${listed(all, 12)}.` };
      const paths = all.map((n) => n.replace(/^[A-Z]+ /, ""));
      const groups = grouped((n) => routeGroup(n.replace(/^[A-Z]+ /, "")));
      return {
        title: all.length <= 3 ? `REST: ${[...new Set(paths)].join(", ")}` : `REST: ${head(groups, 3).replace(/ \+(\d+)$/, " +$1 groups")} (${all.length} routes)`,
        detail: `REST: ${listed(all, 12)}.`,
      };
    }
    case "ddp":
      return { title: `DDP methods: ${head(all, 3)}`, detail: `DDP methods: ${listed(all, 12)}.` };
    case "stream":
      return { title: `DDP subscriptions: ${head(all, 3)}`, detail: `DDP subscriptions: ${listed(all, 12)}.` };
    case "rpc": {
      const ns = grouped(family);
      return { title: `RPC: ${head(ns, 3)} (${count(all.length, "action")})`, detail: `Broker actions: ${listed(all, 12)}.` };
    }
    case "event": {
      const families = grouped(family);
      return { title: `events: ${head(families, 3)} (${all.length})`, detail: `Events: ${listed(all, 12)}.` };
    }
    case "db":
      return { title: head(all, 3), detail: `Collections: ${listed(all, 12)}.` };
    case "route":
      return { title: head(all, 3), detail: `Routes: ${listed(all, 12)}.` };
  }
}

/** A target key as a developer reads it: `GET /api/v1/rooms.info`, `sendMessage`, `users`. */
function displayKey(key: string): string {
  const k = parseTargetKey(key);
  if ("error" in k) return key;
  return k.kind === "http" ? `${k.method} ${k.name}` : k.name;
}
