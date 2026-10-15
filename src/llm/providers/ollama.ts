import { z } from "zod";
import type { LlmAnswer, LlmProvider, LlmRequest } from "../types.js";

export interface OllamaOptions {
  url: string;
  seed: number;
  numCtx: "auto" | number;
  maxCtx: number;
  fetch?: typeof fetch;
}

interface ChatResponse {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string | { type?: string; message?: string; n_prompt_tokens?: number; n_ctx?: number };
}

/**
 * A local model in Ollama: temperature 0, a fixed seed, the schema as the
 * `format` of the answer. The context window is sized for each request. A
 * prompt longer than the window is refused by Ollama with its exact token
 * count; the request is then sent again with a window that fits, so input
 * is never cut silently.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = "ollama" as const;
  private readonly http: typeof fetch;

  constructor(
    readonly model: string,
    private readonly opts: OllamaOptions,
  ) {
    this.http = opts.fetch ?? fetch;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    const t0 = performance.now();
    let numCtx = this.opts.numCtx === "auto" ? windowFor(estimateTokens(req), req.maxTokens, this.opts.maxCtx) : this.opts.numCtx;
    for (let attempt = 0; attempt < 4; attempt++) {
      const data = await this.chat(req, numCtx);
      const error = typeof data.error === "object" ? data.error : data.error ? { message: data.error } : undefined;
      if (error?.type === "exceed_context_size_error" && error.n_prompt_tokens !== undefined) {
        const needed = windowFor(error.n_prompt_tokens, req.maxTokens, this.opts.maxCtx);
        if (needed <= numCtx || error.n_prompt_tokens + req.maxTokens > this.opts.maxCtx) {
          return this.answer(req, t0, "", null, "truncated-input", { input: error.n_prompt_tokens, output: 0 });
        }
        numCtx = needed;
        continue;
      }
      if (error) throw new Error(`ollama: ${error.message ?? JSON.stringify(error)}`);
      const raw = data.message?.content ?? "";
      const stop = data.done_reason === "length" ? "max_tokens" : "end_turn";
      return this.answer(req, t0, raw, data.model ?? null, stop, { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 });
    }
    throw new Error("ollama: the context window could not be sized");
  }

  /** Input tokens as Ollama counts them: a request with a one-token window is refused with the exact count. */
  async countTokens(req: LlmRequest): Promise<number> {
    const data = await this.chat(req, 1);
    const error = typeof data.error === "object" ? data.error : undefined;
    if (error?.n_prompt_tokens !== undefined) return error.n_prompt_tokens;
    return data.prompt_eval_count ?? estimateTokens(req);
  }

  private async chat(req: LlmRequest, numCtx: number): Promise<ChatResponse> {
    const res = await this.http(`${this.opts.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: z.toJSONSchema(req.schema),
        options: { temperature: 0, seed: this.opts.seed, num_ctx: numCtx, num_predict: req.maxTokens },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    return (await res.json()) as ChatResponse;
  }

  private answer<T>(req: LlmRequest<T>, t0: number, raw: string, model: string | null, stop: string, tokens: { input: number; output: number }): LlmAnswer<T> {
    return {
      parsed: stop === "end_turn" ? parseAnswer(req.schema, raw) : null,
      raw,
      stopReason: stop,
      modelRequested: this.model,
      modelActual: model,
      usage: { input: tokens.input, output: tokens.output, cacheRead: 0, cacheWrite: 0 },
      latencyMs: performance.now() - t0,
      costUsd: 0,
      cached: false,
      batchId: null,
    };
  }
}

/** Code tokenizes at roughly three characters per token; the estimate errs high. */
export function estimateTokens(req: LlmRequest): number {
  return Math.ceil((req.system.length + req.user.length) / 3) + 64;
}

/** A window for the prompt and the answer, in steps of 2048 tokens. */
export function windowFor(promptTokens: number, maxTokens: number, maxCtx: number): number {
  const need = promptTokens + maxTokens + 256;
  return Math.min(maxCtx, Math.max(4096, Math.ceil(need / 2048) * 2048));
}

/** The answer parsed against the schema, or null when it is not valid JSON of that shape. */
export function parseAnswer<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
