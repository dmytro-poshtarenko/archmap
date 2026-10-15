import type { Db } from "../store/db.js";

/** Kinds of target in a target key `kind:method:name@component`. */
export const TARGET_KINDS = ["http", "ddp", "action", "event", "coll", "timer"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface TargetKey {
  kind: TargetKind;
  method: string;
  name: string;
  component: string;
}

const KEY = /^(http|ddp|action|event|coll|timer):([^:@\s]+):([^@\s]+)@([a-z0-9*][a-z0-9._-]*|\*)$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "*"]);

/**
 * Parses and checks a target key against the grammar of the labelling guide:
 * `http:<VERB>:<route>@c`, `ddp:call|sub:<name>@c`, `action:-:<service>.<action>@c`,
 * `event:-:<name>@*`, `coll:-:<collection>@c`, `timer:-:<job>@c`.
 */
export function parseTargetKey(key: string): TargetKey | { error: string } {
  const m = KEY.exec(key);
  if (!m) return { error: "expected kind:method:name@component" };
  const [, kind, method, name, component] = m as unknown as [string, TargetKind, string, string, string];
  if (kind === "http" && !HTTP_METHODS.has(method)) return { error: "http method must be GET, POST, PUT, PATCH, DELETE or *" };
  if (kind === "http" && !name.startsWith("/")) return { error: "http route must start with /" };
  if (kind === "ddp" && method !== "call" && method !== "sub") return { error: "ddp method must be call or sub" };
  if (kind !== "http" && kind !== "ddp" && method !== "-") return { error: `${kind} keys use '-' as method` };
  if (kind === "action" && !name.includes(".")) return { error: "action name must be <service>.<action>" };
  if (kind === "event" && component !== "*") return { error: "event keys use '*' as component" };
  if (kind !== "event" && component === "*") return { error: "only event keys use '*' as component" };
  return { kind, method, name, component };
}

export function formatTargetKey(k: TargetKey): string {
  return `${k.kind}:${k.method}:${k.name}@${k.component}`;
}

/**
 * Form in which keys are compared: path parameter names do not matter, so
 * `/livechat/agents/:uid/departments` and `/livechat/agents/:agentId/departments`
 * are the same route.
 */
export function canonicalTargetKey(key: string): string {
  if (!key.startsWith("http:")) return key;
  return key.replace(/\/:[A-Za-z_][\w]*/g, "/:p");
}

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
