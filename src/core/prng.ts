import { sha256Hex } from "./hash.js";

/** Maps a hex digest to a number in [0, 1) using its first 52 bits. */
export function unitInterval(hex: string): number {
  return Number.parseInt(hex.slice(0, 13), 16) / 2 ** 52;
}

/** Derives a 32-bit seed from arbitrary parts, so seeds can be named. */
export function seedFrom(...parts: Array<string | number>): number {
  return Number.parseInt(sha256Hex(parts.join("|")).slice(0, 8), 16) >>> 0;
}

/** Mulberry32: small, fast and fully deterministic for a given seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle that never mutates its input. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
