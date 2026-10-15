import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { costOf } from "../cost.js";
import type { BatchProvider, LlmAnswer, LlmProvider, LlmRequest } from "../types.js";
import { parseAnswer } from "./ollama.js";

/**
 * Claude through the Messages API: structured output from the zod schema,
 * the task's fixed effort (Claude Opus 5.5 takes no temperature, and its
 * thinking cannot be switched off), the stable instructions as a cached
 * system block. No server-side fallbacks: the model that answers is the
 * model asked, and `response.model` is recorded to prove it.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;
  readonly batch: BatchProvider;

  constructor(
    readonly model: string,
    private readonly client: Anthropic = new Anthropic(),
  ) {
    this.batch = {
      submit: (items) => this.submit(items),
      collect: (id, requests) => this.collect(id, requests),
    };
  }

  private params(req: LlmRequest) {
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: req.user }],
    };
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    const t0 = performance.now();
    const response = await this.client.messages.parse({
      ...this.params(req),
      output_config: { effort: req.effort, format: zodOutputFormat(req.schema as never) },
    });
    const raw = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const usage = usageOf(response.usage);
    return {
      parsed: response.stop_reason === "end_turn" ? ((response.parsed_output as T | null) ?? parseAnswer(req.schema, raw)) : null,
      raw,
      stopReason: response.stop_reason ?? null,
      modelRequested: this.model,
      modelActual: response.model,
      usage,
      latencyMs: performance.now() - t0,
      costUsd: costOf(this.model, usage),
      cached: false,
      batchId: null,
    };
  }

  async countTokens(req: LlmRequest): Promise<number> {
    const r = await this.client.messages.countTokens({ model: this.model, system: req.system, messages: [{ role: "user", content: req.user }] });
    return r.input_tokens;
  }

  private async submit(items: Array<{ key: string; req: LlmRequest }>): Promise<string> {
    const batch = await this.client.messages.batches.create({
      requests: items.map(({ key, req }) => ({
        custom_id: key,
        params: { ...this.params(req), output_config: { effort: req.effort, format: { type: "json_schema" as const, schema: zodOutputFormat(req.schema as never).schema } } },
      })),
    });
    return batch.id;
  }

  private async collect(id: string, requests: Map<string, LlmRequest>): Promise<Map<string, LlmAnswer> | null> {
    const batch = await this.client.messages.batches.retrieve(id);
    if (batch.processing_status !== "ended") return null;
    const out = new Map<string, LlmAnswer>();
    for await (const item of await this.client.messages.batches.results(id)) {
      const req = requests.get(item.custom_id);
      if (!req) continue;
      if (item.result.type !== "succeeded") {
        // expired and server errors are retried by the next run; they are not answers
        if (item.result.type === "errored" && item.result.error.error.type === "invalid_request_error") {
          out.set(item.custom_id, failed(this.model, id, `error: ${item.result.error.error.message}`));
        }
        continue;
      }
      const message = item.result.message;
      const raw = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const usage = usageOf(message.usage);
      out.set(item.custom_id, {
        parsed: message.stop_reason === "end_turn" ? parseAnswer(req.schema, raw) : null,
        raw,
        stopReason: message.stop_reason ?? null,
        modelRequested: this.model,
        modelActual: message.model,
        usage,
        latencyMs: 0,
        costUsd: costOf(this.model, usage, true),
        cached: false,
        batchId: id,
      });
    }
    return out;
  }
}

function usageOf(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  return { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

function failed(model: string, batchId: string, stop: string): LlmAnswer {
  return { parsed: null, raw: "", stopReason: stop, modelRequested: model, modelActual: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, latencyMs: 0, costUsd: 0, cached: false, batchId };
}
