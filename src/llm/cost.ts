import type { Usage } from "./types.js";

/** US dollars per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** Writing a five-minute cache entry. */
  cacheWrite: number;
}

/**
 * Prices of the Claude API (claude-api skill, models and prompt-caching
 * references, 2026-10). Message batches cost half of every item.
 */
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** Cost of one answer; zero for local models and models without a price. */
export function costOf(model: string, usage: Usage, batch = false): number {
  const p = PRICES[model];
  if (!p) return 0;
  const usd = (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1_000_000;
  return batch ? usd / 2 : usd;
}

export function hasPrice(model: string): boolean {
  return model in PRICES;
}
