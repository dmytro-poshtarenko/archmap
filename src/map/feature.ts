import { sha256Hex } from "../core/hash.js";
import { q } from "./dsl.js";
import { type MapGraph, type MapRelation, OVERVIEW, type RelationKind } from "./graph.js";

export interface FeatureRequest {
  name: string;
  /**
   * Where the feature starts: an element id (`rocketchat`, `mongo.users`), a
   * route pattern (`/api/v1/rooms.*`), a broker namespace (`ns:presence`), a
   * collection (`coll:users`), or a keyword matched against element titles
   * and target keys.
   */
  seeds: string[];
  /** Relation hops followed from the seeds, 1 to 4. */
  depth: number;
  kinds?: RelationKind[];
  direction?: "in" | "out" | "both";
}

export interface Feature {
  slug: string;
  seeds: string[];
  unmatched: string[];
  elements: string[];
}

/**
 * The view id of a feature name: Latin letters, digits and `_` from the name
 * before any parenthesis (`User presence (sessions, callers)` → `user_presence`);
 * a name with none of them gets a short hash.
 */
export function slugOf(name: string): string {
  const slug = (levelFree(name).split("(")[0] as string)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || `feature_${sha256Hex(name).slice(0, 8)}`;
}

/** A view name without a C4 level the caller may have put in front of it: the map adds its own. */
function levelFree(name: string): string {
  return name.replace(/^\s*C[1-4]\s*:\s*/i, "");
}

/** The elements a seed names. */
export function resolveSeed(graph: MapGraph, seed: string): string[] {
  const ids = new Set(graph.elements.map((e) => e.id));
  if (ids.has(seed)) return [seed];
  if (seed.startsWith("ns:")) return graph.elements.filter((e) => e.kind === "endpointGroup" && e.title === `${seed.slice(3)}.*`).map((e) => e.id);
  if (seed.startsWith("coll:")) return graph.elements.filter((e) => e.kind === "collection" && e.title === seed.slice(5)).map((e) => e.id);
  if (seed.startsWith("/")) {
    // `*` stands for any characters, `/` included: /api/v1/livechat* covers /api/v1/livechat/visitor
    const pattern = new RegExp(`^${seed.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return [...new Set(graph.relations.filter((r) => r.keys.some((k) => k.startsWith("http:") && pattern.test(k.slice(k.indexOf(":", 5) + 1, k.lastIndexOf("@"))))).map((r) => r.target))];
  }
  const word = seed.toLowerCase();
  const byTitle = graph.elements.filter((e) => e.id.toLowerCase().includes(word) || e.title.toLowerCase().includes(word)).map((e) => e.id);
  const byKey = graph.relations.filter((r) => r.keys.some((k) => k.toLowerCase().includes(word))).map((r) => r.target);
  return [...new Set([...byTitle, ...byKey])];
}

/**
 * The elements of a feature: the seeds, then breadth first along relations
 * of the given kinds and direction, `depth` hops. A relation touches an
 * element when it starts or ends at it or inside it.
 */
export function featureOf(graph: MapGraph, req: FeatureRequest): Feature {
  const depth = Math.min(4, Math.max(1, Math.round(req.depth)));
  const direction = req.direction ?? "both";
  const kinds = req.kinds && req.kinds.length > 0 ? new Set(req.kinds) : null;
  // the C2 summary arrows repeat the calls between containers; the search follows the calls themselves
  const relations = graph.relations.filter((r) => !r.tags.includes(OVERVIEW) && (!kinds || kinds.has(r.kind)));
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}.`);
  const seeds: string[] = [];
  const unmatched: string[] = [];
  for (const s of req.seeds) {
    const found = resolveSeed(graph, s);
    if (found.length === 0) unmatched.push(s);
    seeds.push(...found);
  }
  const seen = new Set(seeds);
  let frontier = [...seen];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const el of frontier) {
      for (const r of relations) {
        const out = direction !== "in" && within(r.source, el) ? r.target : null;
        const inn = direction !== "out" && within(r.target, el) ? r.source : null;
        for (const other of [out, inn]) {
          if (other && !seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        }
      }
    }
    frontier = next;
  }
  // an element already shown inside an included parent adds nothing on its own
  const elements = [...seen].filter((e) => ![...seen].some((p) => p !== e && e.startsWith(`${p}.`) && !seeds.includes(e))).sort();
  return { slug: slugOf(req.name), seeds: [...new Set(seeds)].sort(), unmatched, elements };
}

/**
 * The relations a feature view draws, as LikeC4 draws them: an end inside a
 * container shown closed counts as that container; an end inside a container
 * shown open, with some of its elements, is drawn only if it is one of them.
 */
export function featureRelations(graph: MapGraph, f: Feature): MapRelation[] {
  const included = new Set(f.elements);
  const open = (id: string) => f.elements.some((e) => e.startsWith(`${id}.`));
  const shown = (id: string): boolean => {
    if (included.has(id)) return true;
    const parent = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : null;
    if (parent === null) return false;
    return included.has(parent) ? !open(parent) : shown(parent);
  };
  return graph.relations.filter((r) => !r.tags.includes(OVERVIEW) && shown(r.source) && shown(r.target));
}

export function renderFeature(f: Feature, req: FeatureRequest, run: string): string {
  const how = [
    `Seeds: ${req.seeds.join(", ")}${f.unmatched.length > 0 ? ` (no match for ${f.unmatched.join(", ")})` : ""}`,
    `${req.depth} hop${req.depth === 1 ? "" : "s"} ${req.direction === "in" ? "towards the seeds" : req.direction === "out" ? "from the seeds" : "both ways"}`,
    `kinds: ${req.kinds && req.kinds.length > 0 ? req.kinds.join(", ") : "all"}`,
    `run ${run}`,
  ].join("; ");
  // components inside a container make it a C3 view; containers alone, a C2 view
  const level = f.elements.some((e) => e.includes(".")) ? 3 : 2;
  return [
    "views {",
    `  view feature_${f.slug} {`,
    `    title ${q(`C${level}: ${levelFree(req.name)}`)}`,
    `    description ${q(`${how}.`)}`,
    `    include ${f.elements.join(", ")}`,
    `    exclude * -> * where tag is #${OVERVIEW}`,
    "  }",
    "}",
    "",
  ].join("\n");
}
