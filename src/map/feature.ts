import picomatch from "picomatch";
import { q } from "./dsl.js";
import type { MapGraph, RelationKind } from "./graph.js";

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

export function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "feature"
  );
}

/** The elements a seed names. */
export function resolveSeed(graph: MapGraph, seed: string): string[] {
  const ids = new Set(graph.elements.map((e) => e.id));
  if (ids.has(seed)) return [seed];
  if (seed.startsWith("ns:")) return graph.elements.filter((e) => e.kind === "endpointGroup" && e.title === `${seed.slice(3)}.*`).map((e) => e.id);
  if (seed.startsWith("coll:")) return graph.elements.filter((e) => e.kind === "collection" && e.title === seed.slice(5)).map((e) => e.id);
  if (seed.startsWith("/")) {
    const match = picomatch(seed);
    return [...new Set(graph.relations.filter((r) => r.keys.some((k) => k.startsWith("http:") && match(k.slice(k.indexOf(":", 5) + 1, k.lastIndexOf("@"))))).map((r) => r.target))];
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
  const relations = graph.relations.filter((r) => !kinds || kinds.has(r.kind));
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

export function renderFeature(f: Feature, name: string): string {
  return ["views {", `  view feature_${f.slug} {`, `    title ${q(name)}`, `    include ${f.elements.join(", ")}`, "  }", "}", ""].join("\n");
}
