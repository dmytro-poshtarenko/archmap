import type { AbstractValue, Hop, Part } from "../core/types.js";

export const lit = (v: string): AbstractValue => ({ parts: [{ k: "lit", v }], hops: [] });
export const unknown = (why: string): AbstractValue => ({ parts: [{ k: "unknown", why }], hops: [] });
export const dyn = (why: string): AbstractValue => ({ parts: [{ k: "dyn", why }], hops: [] });
export const env = (key: string): AbstractValue => ({ parts: [{ k: "env", key }], hops: [] });
export const setting = (key: string): AbstractValue => ({ parts: [{ k: "setting", key }], hops: [] });

/**
 * Records a hop followed to find a value. Hops are evidence of how a known
 * address was found, so a value that stayed entirely unknown carries none.
 */
export function withHop(value: AbstractValue, hop: Hop): AbstractValue {
  if (isUnknown(value)) return { parts: value.parts, hops: [] };
  return { parts: value.parts, hops: mergeHops([hop], value.hops) };
}

function mergeHops(...lists: Hop[][]): Hop[] {
  const out: Hop[] = [];
  const seen = new Set<string>();
  for (const hop of lists.flat()) {
    const key = `${hop.kind}|${hop.at}|${hop.name ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(hop);
    }
  }
  return out;
}

/** Concatenation, with adjacent literals merged. */
export function concat(...values: AbstractValue[]): AbstractValue {
  const parts: Part[] = [];
  for (const v of values) {
    for (const p of v.parts) {
      const last = parts.at(-1);
      if (p.k === "lit" && last?.k === "lit") parts[parts.length - 1] = { k: "lit", v: last.v + p.v };
      else if (p.k !== "lit" || p.v !== "") parts.push(p);
    }
  }
  return { parts: parts.length > 0 ? parts : [{ k: "lit", v: "" }], hops: mergeHops(...values.map((v) => v.hops)) };
}

/** Alternatives; identical options collapse, a single option is returned as is. */
export function alts(options: AbstractValue[]): AbstractValue {
  const unique = new Map<string, AbstractValue>();
  for (const o of options.flatMap((o) => (o.parts.length === 1 && o.parts[0]?.k === "alts" ? o.parts[0].options : [o]))) {
    const key = display(o);
    if (!unique.has(key)) unique.set(key, o);
  }
  const list = [...unique.values()];
  if (list.length === 1) return list[0] as AbstractValue;
  return { parts: [{ k: "alts", options: list.map((o) => ({ parts: o.parts, hops: [] })) }], hops: mergeHops(...list.map((o) => o.hops)) };
}

/** Whether nothing at all is known about the value. */
export function isUnknown(value: AbstractValue): boolean {
  return value.parts.length === 1 && value.parts[0]?.k === "unknown";
}

/** The literal text, when the whole value is one literal. */
export function literalOf(value: AbstractValue): string | undefined {
  return value.parts.length === 1 && value.parts[0]?.k === "lit" ? value.parts[0].v : undefined;
}

/**
 * Human-readable form, also used by the fixtures: literals as is, `{param:x.y}`,
 * `{env:K}`, `{setting:K}`, `{dyn}`, `{?}`, `{a|b}`.
 */
export function display(value: AbstractValue): string {
  return value.parts.map(displayPart).join("");
}

function displayPart(p: Part): string {
  switch (p.k) {
    case "lit":
      return p.v;
    case "param":
      return `{param:${[p.name, ...p.path].join(".")}}`;
    case "env":
      return `{env:${p.key}}`;
    case "setting":
      return `{setting:${p.key}}`;
    case "dyn":
      return "{dyn}";
    case "unknown":
      return "{?}";
    case "alts":
      return `{${p.options.map(display).join("|")}}`;
  }
}

/** Parameter parts anywhere in the value, alternatives included. */
export function paramParts(value: AbstractValue): Array<Extract<Part, { k: "param" }>> {
  return value.parts.flatMap((p) => (p.k === "param" ? [p] : p.k === "alts" ? p.options.flatMap(paramParts) : []));
}

/**
 * Where a parameter sits in an address: `segment` when it fills a whole path
 * segment (`/orders/${id}`) and may simply be an id, `query` after `?` where
 * it never changes the route, `inside` anywhere else (glued to text, or the
 * whole value), where it decides what is called.
 */
export function paramPositions(value: AbstractValue): Array<{ param: Extract<Part, { k: "param" }>; position: "segment" | "query" | "inside" }> {
  const out: Array<{ param: Extract<Part, { k: "param" }>; position: "segment" | "query" | "inside" }> = [];
  let inQuery = false;
  let sawPath = false;
  value.parts.forEach((p, i) => {
    if (p.k === "lit") {
      if (p.v.includes("?")) inQuery = true;
      if (/[^/]/.test(p.v.replace(/^[a-z]+:\/\/[^/]*/i, ""))) sawPath = true;
      return;
    }
    if (p.k === "alts") {
      for (const o of p.options) for (const inner of paramParts(o)) out.push({ param: inner, position: inQuery ? "query" : "inside" });
      return;
    }
    if (p.k !== "param") return;
    if (inQuery) return out.push({ param: p, position: "query" });
    const prev = value.parts[i - 1];
    const next = value.parts[i + 1];
    const startsSegment = prev?.k === "lit" && prev.v.endsWith("/");
    const endsSegment = next === undefined || (next.k === "lit" && /^[/?#]/.test(next.v));
    out.push({ param: p, position: startsSegment && endsSegment && sawPath ? "segment" : "inside" });
  });
  return out;
}

/** Joins a base URL and a path the way HTTP clients do (`/api` + `/orders`). */
export function joinUrl(base: AbstractValue, path: AbstractValue): AbstractValue {
  const first = path.parts[0];
  if (first?.k === "lit" && /^[a-z][a-z0-9+.-]*:\/\//i.test(first.v)) return { parts: path.parts, hops: path.hops };
  const baseParts = [...base.parts];
  const last = baseParts.at(-1);
  if (last?.k === "lit") baseParts[baseParts.length - 1] = { k: "lit", v: last.v.replace(/\/+$/, "") };
  const pathParts = [...path.parts];
  if (first?.k === "lit") pathParts[0] = { k: "lit", v: first.v.startsWith("/") || first.v === "" ? first.v : `/${first.v}` };
  else pathParts.unshift({ k: "lit", v: "/" });
  return concat({ parts: baseParts, hops: base.hops }, { parts: pathParts, hops: path.hops });
}

/** Sorted, distinct hop kinds of a value: what the fixtures record. */
export function hopKinds(value: AbstractValue): string[] {
  return [...new Set(value.hops.map((h) => h.kind))].sort();
}
