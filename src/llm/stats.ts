import { canonicalJson } from "../core/hash.js";
import type { Db } from "../store/db.js";

export interface TaskStats {
  task: string;
  provider: string;
  answers: number;
  parsed: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Requests repeated for the stability check, and how many gave the same answer every time. */
  repeated: number;
  stable: number;
  byStop: Record<string, number>;
  models: Record<string, number>;
}

/** What the answer cache holds per task and provider, with the stability of repeated requests. */
export function llmStats(db: Db): TaskStats[] {
  const rows = db
    .prepare("SELECT task, provider, model_actual, repeat, prompt_hash, parsed, stop_reason, cost_usd, input_tokens + cache_read + cache_write AS input, output_tokens FROM llm_answer")
    .all() as Array<{ task: string; provider: string; model_actual: string | null; repeat: number; prompt_hash: string; parsed: string | null; stop_reason: string | null; cost_usd: number; input: number; output_tokens: number }>;
  const groups = new Map<string, TaskStats & { byPrompt: Map<string, Map<number, string>> }>();
  for (const r of rows) {
    const key = `${r.task}|${r.provider}`;
    const g =
      groups.get(key) ??
      ({ task: r.task, provider: r.provider, answers: 0, parsed: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, repeated: 0, stable: 0, byStop: {}, models: {}, byPrompt: new Map() } as TaskStats & { byPrompt: Map<string, Map<number, string>> });
    g.answers++;
    if (r.parsed !== null) g.parsed++;
    g.costUsd += r.cost_usd;
    g.inputTokens += r.input;
    g.outputTokens += r.output_tokens;
    const stop = r.stop_reason ?? "none";
    g.byStop[stop] = (g.byStop[stop] ?? 0) + 1;
    const model = r.model_actual ?? "unknown";
    g.models[model] = (g.models[model] ?? 0) + 1;
    const byRepeat = g.byPrompt.get(r.prompt_hash) ?? new Map<number, string>();
    byRepeat.set(r.repeat, r.parsed === null ? "∅" : decisionOf(JSON.parse(r.parsed)));
    g.byPrompt.set(r.prompt_hash, byRepeat);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ byPrompt, ...g }) => {
    for (const answers of byPrompt.values()) {
      if (answers.size < 2) continue;
      g.repeated++;
      if (new Set(answers.values()).size === 1) g.stable++;
    }
    return g;
  });
}

/**
 * The part of an answer that decides something: confidences dropped and
 * lists sorted, so the same decision in another order or with another
 * confidence counts as the same answer.
 */
export function decisionOf(value: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip).map((x) => canonicalJson(x)).sort();
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "confidence").map(([k, x]) => [k, strip(x)]));
    return v;
  };
  return canonicalJson(strip(value));
}
