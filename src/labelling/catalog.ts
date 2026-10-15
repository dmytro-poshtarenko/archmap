import { canonicalTargetKey, parseTargetKey, type TargetKind } from "../core/keys.js";
import type { Db } from "../store/db.js";

export { canonicalTargetKey, formatTargetKey, parseTargetKey, TARGET_KINDS, type TargetKey, type TargetKind } from "../core/keys.js";

export interface CatalogEntry {
  key: string;
  kind: TargetKind;
  name: string;
  component: string | null;
  source: string | null;
  origin: "extracted" | "manual";
  note: string | null;
}

/**
 * Replaces the extracted entries; manual entries added while labelling are
 * kept. Keys equal up to path parameter names are stored once.
 */
export function storeCatalog(db: Db, entries: Array<Omit<CatalogEntry, "origin">>): number {
  const insert = db.prepare(
    `INSERT INTO catalog(key, kind, name, component, source, origin, note)
     VALUES (@key, @kind, @name, @component, @source, 'extracted', @note)
     ON CONFLICT(key) DO NOTHING`,
  );
  const seen = new Set<string>();
  let added = 0;
  db.transaction(() => {
    db.exec("DELETE FROM catalog WHERE origin = 'extracted'");
    for (const e of entries) {
      const canonical = canonicalTargetKey(e.key);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      added += insert.run(e).changes;
    }
  })();
  return added;
}

export function addManualEntry(db: Db, key: string, note: string | null): CatalogEntry {
  const parsed = parseTargetKey(key);
  if ("error" in parsed) throw new Error(`invalid target key '${key}': ${parsed.error}`);
  const entry: CatalogEntry = {
    key,
    kind: parsed.kind,
    name: parsed.name,
    component: parsed.component,
    source: null,
    origin: "manual",
    note,
  };
  db.prepare(
    `INSERT INTO catalog(key, kind, name, component, source, origin, note)
     VALUES (@key, @kind, @name, @component, @source, @origin, @note)
     ON CONFLICT(key) DO UPDATE SET note = coalesce(excluded.note, catalog.note)`,
  ).run(entry);
  return entry;
}

/**
 * Entries whose key or note contains every word of the query. Ranked by how
 * well the first word names the target: the exact name, then the model or
 * interface named in the note (`Messages` finds its collection first), then
 * the name ending with it; shorter keys first within a rank.
 */
export function searchCatalog(db: Db, query: string, limit = 30): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const where = words.map(() => "(lower(key) LIKE ? OR lower(coalesce(note, '')) LIKE ?)").join(" AND ");
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
  const first = words[0] ?? "";
  return db
    .prepare(
      `SELECT key, kind, name, component, source, origin, note FROM catalog
       ${words.length > 0 ? `WHERE ${where}` : ""}
       ORDER BY CASE
         WHEN lower(name) = @first THEN 0
         WHEN lower(coalesce(note, '')) = @first OR lower(coalesce(note, '')) LIKE @first || ' %' THEN 1
         WHEN lower(name) LIKE '%' || @first OR lower(name) LIKE '%/' || @first || '%' THEN 2
         ELSE 3 END, length(key), key
       LIMIT @limit`,
    )
    .all(...params, { first, limit }) as CatalogEntry[];
}

export function hasCatalogKey(db: Db, key: string): boolean {
  const canonical = canonicalTargetKey(key);
  if (canonical === key) return db.prepare("SELECT 1 FROM catalog WHERE key = ?").get(key) !== undefined;
  const sameRoute = db.prepare("SELECT key FROM catalog WHERE kind = 'http'").pluck().all() as string[];
  return sameRoute.some((k) => canonicalTargetKey(k) === canonical);
}
