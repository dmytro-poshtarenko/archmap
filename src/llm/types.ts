import type { z } from "zod";
import type { Effort } from "../config/schema.js";

export type TaskId = "extract-routes" | "resolve-select" | "resolve-free" | "memo-probe";
export type ProviderId = "anthropic" | "claude-code" | "ollama" | "replay";

/** One request to a language model, as every provider receives it. */
export interface LlmRequest<T = unknown> {
  task: TaskId;
  /** `<prompt id>@<version>` of the template the request was rendered from. */
  template: string;
  /** What the request is about: a file, a call site; for the log and the cache index. */
  subject: string;
  /** Stable instructions and the description of the system: the cached prefix. */
  system: string;
  /** The request itself: a file with line numbers, a code fragment with candidates. */
  user: string;
  /** Shape of the answer; providers ask for it as structured output. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Cloud model only: the fixed effort of the task. */
  effort: Effort;
  /** 0 for the answer used; 1, 2, … for the stability repeats. */
  repeat: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * An answer: the parsed output when it matched the schema, the raw text,
 * and why the model stopped. A refusal, a cut at max_tokens or a truncated
 * input give no parsed output, and the method then treats the request as
 * "no link".
 */
export interface LlmAnswer<T = unknown> {
  parsed: T | null;
  raw: string;
  stopReason: string | null;
  modelRequested: string;
  /** The model that actually answered (`response.model`). */
  modelActual: string | null;
  usage: Usage;
  latencyMs: number;
  costUsd: number;
  /** Served from the answer cache: no request was made. */
  cached: boolean;
  batchId: string | null;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>>;
  /** Input tokens of a request, counted by the provider's tokenizer when it has one. */
  countTokens?(req: LlmRequest): Promise<number>;
  /** Asynchronous batch at reduced price, where the provider has one. */
  batch?: BatchProvider;
}

export interface BatchProvider {
  submit(items: Array<{ key: string; req: LlmRequest }>): Promise<string>;
  /** The answers by key once the batch has ended, or null while it runs. */
  collect(id: string, requests: Map<string, LlmRequest>): Promise<Map<string, LlmAnswer> | null>;
}

export class BudgetExceededError extends Error {}
