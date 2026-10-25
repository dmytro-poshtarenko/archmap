import type { Db } from "../store/db.js";
import { cacheKey, readAnswer, writeAnswer } from "./cache.js";
import { costOf, hasPrice } from "./cost.js";
import { estimateTokens } from "./providers/ollama.js";
import type { ReplayProvider } from "./providers/replay.js";
import { BudgetExceededError, type LlmAnswer, type LlmProvider, type LlmRequest, type ProviderId } from "./types.js";

export interface ClientStats {
  requests: number;
  cacheHits: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  byStop: Record<string, number>;
  models: Record<string, number>;
}

export interface ClientOptions {
  /** Spending limit over every answer stored for priced models, in US dollars. */
  budgetUsd: number;
  /** Requests at once for providers without batches. */
  concurrency?: number;
  /** Send this many requests or more as one message batch, when the provider has batches. */
  batchFrom?: number;
  /** Seconds between polls of a running batch. */
  pollSeconds?: number;
  log?: (message: string) => void;
}

/**
 * The only way the method talks to a model: the answer cache first, then
 * the budget check, then the provider (or a message batch). Every answer is
 * stored with the model that gave it.
 */
export class LlmClient {
  readonly stats: ClientStats = { requests: 0, cacheHits: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, byStop: {}, models: {} };
  private readonly identity: { provider: ProviderId; model: string };

  constructor(
    private readonly db: Db,
    readonly provider: LlmProvider,
    private readonly opts: ClientOptions,
  ) {
    this.identity = provider.id === "replay" ? (provider as ReplayProvider).recorded : { provider: provider.id, model: provider.model };
  }

  /** `local`, `cloud` or `replay`: the tag of runs made with this client; the cloud model is `cloud` through either channel. */
  get tag(): string {
    const p = this.identity.provider;
    return p === "anthropic" || p === "claude-code" ? "cloud" : p === "ollama" ? "local" : "replay";
  }

  get model(): string {
    return this.identity.model;
  }

  keyOf(req: LlmRequest): string {
    return cacheKey(this.identity.provider, this.identity.model, req);
  }

  async ask<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    const [answer] = await this.askMany([req]);
    return answer as LlmAnswer<T>;
  }

  /**
   * Answers in request order. Cached answers cost nothing; the rest go to a
   * message batch when there are enough of them and the provider has one,
   * otherwise to the provider a few at a time.
   */
  async askMany<T>(reqs: Array<LlmRequest<T>>): Promise<Array<LlmAnswer<T>>> {
    const out = new Array<LlmAnswer<T> | undefined>(reqs.length);
    const missing: Array<{ index: number; key: string; req: LlmRequest<T> }> = [];
    reqs.forEach((req, index) => {
      const key = this.keyOf(req);
      const hit = readAnswer(this.db, key);
      if (hit) {
        this.stats.cacheHits++;
        out[index] = hit as LlmAnswer<T>;
      } else missing.push({ index, key, req });
    });
    if (missing.length > 0) {
      if (this.provider.id === "replay") throw new Error(`replay: ${missing.length} requests were never recorded`);
      this.checkBudget(missing.map((m) => m.req));
      const batch = this.provider.batch;
      if (batch && missing.length >= (this.opts.batchFrom ?? 20)) await this.viaBatch(missing, out);
      else await this.oneByOne(missing, out);
    }
    return out.map((a, i) => a ?? failure(reqs[i] as LlmRequest<T>, this.identity.model, "error: no answer"));
  }

  private async oneByOne<T>(missing: Array<{ index: number; key: string; req: LlmRequest<T> }>, out: Array<LlmAnswer<T> | undefined>): Promise<void> {
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < missing.length) {
        const m = missing[next++] as (typeof missing)[number];
        const a = await this.provider.complete(m.req);
        this.record(m.key, m.req, a);
        out[m.index] = a;
        done++;
        if (done % 10 === 0 || done === missing.length) this.opts.log?.(`${m.req.task}: ${done}/${missing.length} answered, $${this.stats.costUsd.toFixed(2)}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.opts.concurrency ?? 1) }, worker));
  }

  private async viaBatch<T>(missing: Array<{ index: number; key: string; req: LlmRequest<T> }>, out: Array<LlmAnswer<T> | undefined>): Promise<void> {
    const batch = this.provider.batch as NonNullable<LlmProvider["batch"]>;
    const requests = new Map(missing.map((m) => [m.key, m.req as LlmRequest]));
    const id = await batch.submit(missing.map((m) => ({ key: m.key, req: m.req as LlmRequest })));
    this.db
      .prepare("INSERT INTO llm_batch(id, provider, task, requests, status, created_at) VALUES (?, ?, ?, ?, 'submitted', ?)")
      .run(id, this.identity.provider, missing[0]?.req.task ?? "", JSON.stringify(Object.fromEntries(missing.map((m) => [m.key, m.req.subject]))), new Date().toISOString());
    this.opts.log?.(`batch ${id}: ${missing.length} requests submitted`);
    for (;;) {
      const answers = await batch.collect(id, requests);
      if (answers) {
        for (const m of missing) {
          const a = answers.get(m.key);
          if (!a) continue;
          this.record(m.key, m.req, a);
          out[m.index] = a as LlmAnswer<T>;
        }
        this.db.prepare("UPDATE llm_batch SET status = 'collected' WHERE id = ?").run(id);
        return;
      }
      await new Promise((r) => setTimeout(r, (this.opts.pollSeconds ?? 60) * 1000));
    }
  }

  private record(key: string, req: LlmRequest, a: LlmAnswer): void {
    writeAnswer(this.db, key, this.identity.provider, req, a);
    this.stats.requests++;
    this.stats.costUsd += a.costUsd;
    this.stats.inputTokens += a.usage.input + a.usage.cacheRead + a.usage.cacheWrite;
    this.stats.outputTokens += a.usage.output;
    const stop = a.stopReason ?? "none";
    this.stats.byStop[stop] = (this.stats.byStop[stop] ?? 0) + 1;
    const model = a.modelActual ?? "unknown";
    this.stats.models[model] = (this.stats.models[model] ?? 0) + 1;
  }

  /** Refuses requests whose worst-case cost would take the spending over the budget. */
  private checkBudget(reqs: LlmRequest[]): void {
    if (!hasPrice(this.identity.model)) return;
    const spent = (this.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM llm_answer").get() as { s: number }).s;
    const worst = reqs.reduce((sum, r) => sum + costOf(this.identity.model, { input: estimateTokens(r), output: r.maxTokens, cacheRead: 0, cacheWrite: 0 }), 0);
    if (spent + worst > this.opts.budgetUsd) {
      throw new BudgetExceededError(`${reqs.length} requests may cost up to $${worst.toFixed(2)}; $${spent.toFixed(2)} of the $${this.opts.budgetUsd} budget is spent`);
    }
  }
}

function failure<T>(req: LlmRequest<T>, model: string, stop: string): LlmAnswer<T> {
  return { parsed: null, raw: "", stopReason: stop, modelRequested: model, modelActual: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, latencyMs: 0, costUsd: 0, cached: false, batchId: null };
}

/**
 * The stability repeats of a set of requests: for a fixed share of them
 * (chosen by their content, so the same ones every run), the same request
 * with repeat numbers 1, 2, …
 */
export function repeatsOf<T>(reqs: Array<LlmRequest<T>>, share: number, repeats: number, keyOf: (r: LlmRequest<T>) => string): Array<LlmRequest<T>> {
  if (share <= 0 || repeats <= 1) return [];
  return reqs.filter((r) => Number.parseInt(keyOf(r).slice(0, 8), 16) / 0xffffffff < share).flatMap((r) => Array.from({ length: repeats - 1 }, (_, i) => ({ ...r, repeat: i + 1 })));
}

