import type { TargetConfig } from "../config/schema.js";
import { parseTargetKey } from "../core/keys.js";
import type { CallSite } from "../core/types.js";
import type { StoredLink } from "../match/run.js";

/** Kinds of relations on the map: the interaction types, with broker actions as `rpc` and events apart. */
export type RelationKind = "http" | "ddp" | "rpc" | "event" | "db" | "trigger";

export interface MapElement {
  /** LikeC4 name, unique among its siblings. */
  name: string;
  /** Full id: `parent.name` for nested elements. */
  id: string;
  kind: "client" | "service" | "gateway" | "bus" | "database" | "collection" | "scheduler" | "external" | "endpointGroup";
  title: string;
  parent: string | null;
  tags: string[];
  metadata: Record<string, string>;
}

export interface MapRelation {
  source: string;
  target: string;
  kind: RelationKind;
  title: string;
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
 * metadata holds cases, one call site and the run.
 */
export function buildGraph(config: TargetConfig, run: string, sites: CallSite[], links: StoredLink[]): MapGraph {
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
      tags,
      metadata: { case: [...r.cases].sort((x, y) => x - y).join(","), callsite: r.sites[0] ?? "", sites: String(r.sites.length), run },
      keys: r.keys.sort(),
      sites: r.sites.sort(),
    };
  });
  out.sort((a, b) => (a.source + a.target + a.kind < b.source + b.target + b.kind ? -1 : 1));
  const list = [...elements.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { elements: list, relations: out };
}
