import type { CatalogEntry } from "../catalog.js";
import type { Snapshot } from "../snapshot.js";
import { extractRocketChatCatalog } from "./rocketchat.js";

type Extractor = (snapshot: Snapshot) => Array<Omit<CatalogEntry, "origin">>;

/** Catalog extractors by pattern pack id; a pack without one contributes nothing. */
const EXTRACTORS: Record<string, Extractor> = {
  rocketchat: extractRocketChatCatalog,
};

export function extractCatalog(packRefs: string[], snapshot: Snapshot): Array<Omit<CatalogEntry, "origin">> {
  const out: Array<Omit<CatalogEntry, "origin">> = [];
  for (const ref of packRefs) {
    const extractor = EXTRACTORS[ref.split("@")[0] ?? ""];
    if (extractor) out.push(...extractor(snapshot));
  }
  return out;
}
