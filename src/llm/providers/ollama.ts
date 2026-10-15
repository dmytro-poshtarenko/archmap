import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { LlmAnswer, LlmProvider, LlmRequest } from "../types.js";

/** Posts JSON and returns the parsed JSON answer, whatever the HTTP status. */
export type PostJson = (url: string, body: unknown) => Promise<unknown>;

export interface OllamaOptions {
  url: string;
  seed: number;
  numCtx: "auto" | number;
  maxCtx: number;
  post?: PostJson;
}

/**
 * JSON over node:http, with one long limit instead of fetch's five minutes
 * until the headers: Ollama answers only when the whole answer is ready, and
 * a long prompt on a local model takes longer than that.
 */
export function postJson(timeoutMs = 60 * 60 * 1000): PostJson {
  return (url, body) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const send = u.protocol === "https:" ? httpsRequest : httpRequest;
      const payload = JSON.stringify(body);
      const req = send(u, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from ${u.host} in ${Math.round(timeoutMs / 60000)} min`)));
      req.on("error", reject);
      req.end(payload);
    });
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
  private readonly post: PostJson;

  constructor(
    readonly model: string,
    private readonly opts: OllamaOptions,
  ) {
    this.post = opts.post ?? postJson();
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    const t0 = performance.now();
    // a long prompt is counted exactly first: an estimate that falls short leaves too little room to answer
    const estimate = estimateTokens(req);
    const prompt = this.opts.numCtx === "auto" && estimate > EXACT_FROM ? await this.countTokens(req) : estimate;
    let numCtx = this.opts.numCtx === "auto" ? windowFor(prompt, req.maxTokens, this.opts.maxCtx) : this.opts.numCtx;
    for (let attempt = 0; attempt < 4; attempt++) {
      const data = await this.chat(req, numCtx);
      const error = errorOf(data.error);
      if (error?.type === "exceed_context_size_error" && error.n_prompt_tokens !== undefined) {
        const needed = windowFor(error.n_prompt_tokens, req.maxTokens, this.opts.maxCtx);
        if (needed <= numCtx || error.n_prompt_tokens + req.maxTokens > this.opts.maxCtx) {
          return this.answer(req, t0, "", null, "truncated-input", { input: error.n_prompt_tokens, output: 0 });
        }
        numCtx = needed;
        continue;
      }
      if (error) throw new Error(`ollama: ${error.message ?? JSON.stringify(error)}`);
      const used = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
      if (used >= numCtx - 1) {
        // the answer reached the end of the window: the server may have shifted the context, dropping input
        const wider = Math.min(this.opts.maxCtx, numCtx + req.maxTokens + 2048);
        if (wider > numCtx) {
          numCtx = wider;
          continue;
        }
        return this.answer(req, t0, data.message?.content ?? "", data.model ?? null, "truncated-input", { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 });
      }
      const raw = data.message?.content ?? "";
      const stop = data.done_reason === "length" ? "max_tokens" : "end_turn";
      return this.answer(req, t0, raw, data.model ?? null, stop, { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 });
    }
    throw new Error("ollama: the context window could not be sized");
  }

  /** Input tokens as Ollama counts them: a request with a one-token window is refused with the exact count. */
  async countTokens(req: LlmRequest): Promise<number> {
    const data = await this.chat(req, 1);
    const error = errorOf(data.error);
    if (error?.n_prompt_tokens !== undefined) return error.n_prompt_tokens;
    return data.prompt_eval_count ?? estimateTokens(req);
  }

  private async chat(req: LlmRequest, numCtx: number): Promise<ChatResponse> {
    return (await this.post(`${this.opts.url}/api/chat`, {
      model: this.model,
      stream: false,
      think: false,
      format: z.toJSONSchema(req.schema),
      options: { temperature: 0, seed: this.opts.seed, num_ctx: numCtx, num_predict: req.maxTokens },
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    })) as ChatResponse;
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

type OllamaError = { type?: string; message?: string; n_prompt_tokens?: number; n_ctx?: number };

/**
 * Ollama's error field: an object, or a string that holds the JSON of the
 * underlying server's error (`{"error":{"type":"exceed_context_size_error",…}}`).
 */
export function errorOf(field: ChatResponse["error"]): OllamaError | undefined {
  if (field === undefined || field === null) return undefined;
  if (typeof field === "object") return field;
  try {
    const parsed = JSON.parse(field) as { error?: OllamaError } | OllamaError;
    return typeof parsed === "object" && parsed !== null && "error" in parsed && parsed.error ? parsed.error : (parsed as OllamaError);
  } catch {
    return { message: field };
  }
}

/** Prompts estimated above this many tokens are counted exactly before they are sent. */
const EXACT_FROM = 8192;

/** Code tokenizes at roughly three characters per token (numbered code nearer 2.5); a first guess only. */
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
