import { hashOf, sha256Hex } from "../core/hash.js";
import type { Db } from "../store/db.js";
import type { LlmAnswer, LlmRequest, ProviderId } from "./types.js";
import { z } from "zod";

/**
 * The cache key of a request: the task, the provider and model, the prompt
 * as sent (system, user, schema, limits, effort) and the repeat number. The
 * same request is never sent twice.
 */
export function cacheKey(provider: ProviderId, model: string, req: LlmRequest): string {
  return sha256Hex(`${req.task}\u0000${provider}\u0000${model}\u0000${promptHash(req)}\u0000${req.repeat}`);
}

export function promptHash(req: LlmRequest): string {
  return hashOf({ system: req.system, user: req.user, schema: z.toJSONSchema(req.schema), maxTokens: req.maxTokens, effort: req.effort, template: req.template });
}

export function readAnswer(db: Db, key: string): LlmAnswer | undefined {
  const row = db.prepare("SELECT * FROM llm_answer WHERE cache_key = ?").get(key) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    parsed: row.parsed === null ? null : JSON.parse(String(row.parsed)),
    raw: String(row.raw),
    stopReason: row.stop_reason === null ? null : String(row.stop_reason),
    modelRequested: String(row.model_req),
    modelActual: row.model_actual === null ? null : String(row.model_actual),
    usage: { input: Number(row.input_tokens), output: Number(row.output_tokens), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write) },
    latencyMs: Number(row.latency_ms),
    costUsd: Number(row.cost_usd),
    cached: true,
    batchId: row.batch_id === null ? null : String(row.batch_id),
  };
}

export function writeAnswer(db: Db, key: string, provider: ProviderId, req: LlmRequest, a: LlmAnswer): void {
  db.prepare(
    `INSERT INTO llm_answer(cache_key, task, provider, model_req, model_actual, repeat, prompt_hash, template, subject, raw, parsed, stop_reason,
       input_tokens, output_tokens, cache_read, cache_write, latency_ms, cost_usd, batch_id, created_at)
     VALUES (@key, @task, @provider, @modelReq, @modelActual, @repeat, @promptHash, @template, @subject, @raw, @parsed, @stopReason,
       @input, @output, @cacheRead, @cacheWrite, @latencyMs, @costUsd, @batchId, @createdAt)
     ON CONFLICT(cache_key) DO NOTHING`,
  ).run({
    key,
    task: req.task,
    provider,
    modelReq: a.modelRequested,
    modelActual: a.modelActual,
    repeat: req.repeat,
    promptHash: promptHash(req),
    template: req.template,
    subject: req.subject,
    raw: a.raw,
    parsed: a.parsed === null ? null : JSON.stringify(a.parsed),
    stopReason: a.stopReason,
    ...a.usage,
    latencyMs: Math.round(a.latencyMs),
    costUsd: a.costUsd,
    batchId: a.batchId,
    createdAt: new Date().toISOString(),
  });
}
