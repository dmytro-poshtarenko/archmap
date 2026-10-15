import { createHash } from "node:crypto";

/**
 * Serialises a value to JSON with object keys sorted at every level, so that
 * two structurally equal values always produce the same string. Properties
 * whose value is `undefined` are dropped, as `JSON.stringify` would do.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable content hash of any JSON-compatible value. */
export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
