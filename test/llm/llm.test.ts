import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cacheKey } from "../../src/llm/cache.js";
import { LlmClient, repeatsOf } from "../../src/llm/client.js";
import { loadTemplate, render } from "../../src/llm/prompts.js";
import { OllamaProvider, windowFor } from "../../src/llm/providers/ollama.js";
import { ReplayProvider } from "../../src/llm/providers/replay.js";
import { decisionOf } from "../../src/llm/stats.js";
import { chunksOf, filesForExtraction, routesFromAnswer, type SourceFile } from "../../src/llm/tasks/extractRoutes.js";
import { chosen, fragmentOf } from "../../src/llm/tasks/resolve.js";
import { BudgetExceededError, type LlmAnswer, type LlmProvider, type LlmRequest } from "../../src/llm/types.js";
import { openDb } from "../../src/store/db.js";

const Answer = z.object({ value: z.string() });

const request = (user: string, repeat = 0): LlmRequest<z.infer<typeof Answer>> => ({
  task: "resolve-free",
  template: "resolve-free@1",
  subject: user,
  system: "system",
  user,
  schema: Answer,
  maxTokens: 100,
  effort: "low",
  repeat,
});

/** A provider answering every request with its user text, counting the calls it gets. */
class EchoProvider implements LlmProvider {
  readonly id = "ollama" as const;
  readonly model = "echo";
  calls = 0;
  async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    this.calls++;
    const raw = JSON.stringify({ value: req.user });
    return { parsed: JSON.parse(raw) as T, raw, stopReason: "end_turn", modelRequested: "echo", modelActual: "echo-1", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, latencyMs: 1, costUsd: 0, cached: false, batchId: null };
  }
}

describe("prompts", () => {
  it("load with their id and version and fill every placeholder", () => {
    const t = loadTemplate("resolve-select@1");
    expect(t.id).toBe("resolve-select");
    expect(render("{{a}} and {{b}}", { a: "x", b: "y" })).toBe("x and y");
    expect(() => render("{{missing}}", {})).toThrow(/missing/);
  });
});

describe("the answer cache", () => {
  it("asks once: a repeated run is served from the cache for free", async () => {
    const db = openDb(":memory:");
    const provider = new EchoProvider();
    const first = new LlmClient(db, provider, { budgetUsd: 1 });
    const answers = await first.askMany([request("a"), request("b")]);
    expect(answers.map((a) => a.parsed?.value)).toEqual(["a", "b"]);
    const second = new LlmClient(db, provider, { budgetUsd: 1 });
    await second.askMany([request("a"), request("b")]);
    expect(provider.calls).toBe(2);
    expect(second.stats).toMatchObject({ requests: 0, cacheHits: 2, costUsd: 0 });
    const stored = db.prepare("SELECT model_actual, template FROM llm_answer").all();
    expect(stored).toEqual([
      { model_actual: "echo-1", template: "resolve-free@1" },
      { model_actual: "echo-1", template: "resolve-free@1" },
    ]);
  });

  it("keys requests by provider, model, prompt and repeat", () => {
    const k = cacheKey("ollama", "m", request("a"));
    expect(cacheKey("ollama", "m", request("a"))).toBe(k);
    expect(cacheKey("anthropic", "m", request("a"))).not.toBe(k);
    expect(cacheKey("ollama", "m", request("a", 1))).not.toBe(k);
    expect(cacheKey("ollama", "m", { ...request("a"), effort: "high" })).not.toBe(k);
  });

  it("replays recorded answers and refuses requests never recorded", async () => {
    const db = openDb(":memory:");
    await new LlmClient(db, new EchoProvider(), { budgetUsd: 1 }).ask(request("a"));
    const replay = new LlmClient(db, new ReplayProvider(db, { provider: "ollama", model: "echo" }), { budgetUsd: 1 });
    expect((await replay.ask(request("a"))).parsed).toEqual({ value: "a" });
    await expect(replay.ask(request("never"))).rejects.toThrow(/never recorded/);
  });

  it("refuses requests that could take the spending over the budget", async () => {
    const db = openDb(":memory:");
    const priced: LlmProvider = { id: "anthropic", model: "claude-opus-5-5", complete: () => Promise.reject(new Error("must not be called")) };
    const client = new LlmClient(db, priced, { budgetUsd: 0.001 });
    await expect(client.ask({ ...request("x".repeat(30000)), maxTokens: 8000 })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("repeats the same share of requests every time", () => {
    const reqs = Array.from({ length: 400 }, (_, i) => request(`q${i}`));
    const key = (r: LlmRequest) => cacheKey("ollama", "m", r);
    const repeats = repeatsOf(reqs, 0.1, 3, key);
    expect(repeatsOf(reqs, 0.1, 3, key)).toEqual(repeats);
    expect(repeats.length / 2 / 400).toBeGreaterThan(0.06);
    expect(repeats.length / 2 / 400).toBeLessThan(0.14);
    expect(new Set(repeats.map((r) => r.repeat))).toEqual(new Set([1, 2]));
  });

  it("compares decisions, not confidences or order", () => {
    expect(decisionOf({ choice: "C1", confidence: 0.9 })).toBe(decisionOf({ confidence: 0.4, choice: "C1" }));
    expect(decisionOf({ routes: [{ name: "a" }, { name: "b" }] })).toBe(decisionOf({ routes: [{ name: "b" }, { name: "a" }] }));
  });
});

describe("the Ollama provider", () => {
  it("never cuts the input: a refused prompt is sent again with a window that fits", async () => {
    const windows: number[] = [];
    const fake = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { options: { num_ctx: number; temperature: number; seed: number } };
      windows.push(body.options.num_ctx);
      expect(body.options).toMatchObject({ temperature: 0, seed: 42 });
      if (body.options.num_ctx < 13932 + 100) {
        return { json: async () => ({ error: { type: "exceed_context_size_error", message: "too long", n_prompt_tokens: 13932, n_ctx: body.options.num_ctx } }) };
      }
      return { json: async () => ({ model: "qwen", message: { content: '{"value":"ok"}' }, done_reason: "stop", prompt_eval_count: 13932, eval_count: 4 }) };
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("qwen", { url: "http://x", seed: 42, numCtx: 4096, maxCtx: 131072, fetch: fake });
    const a = await p.complete(request("long"));
    expect(a.parsed).toEqual({ value: "ok" });
    expect(a.usage.input).toBe(13932);
    expect(windows).toEqual([4096, windowFor(13932, 100, 131072)]);
  });

  it("reports a cut answer and an input beyond the largest window", async () => {
    const cut = (async () => ({ json: async () => ({ model: "qwen", message: { content: '{"val' }, done_reason: "length", prompt_eval_count: 10, eval_count: 100 }) })) as unknown as typeof fetch;
    const a = await new OllamaProvider("qwen", { url: "http://x", seed: 1, numCtx: "auto", maxCtx: 8192, fetch: cut }).complete(request("q"));
    expect(a).toMatchObject({ parsed: null, stopReason: "max_tokens" });
    const huge = (async () => ({ json: async () => ({ error: { type: "exceed_context_size_error", n_prompt_tokens: 50000, n_ctx: 8192 } }) })) as unknown as typeof fetch;
    const b = await new OllamaProvider("qwen", { url: "http://x", seed: 1, numCtx: 8192, maxCtx: 8192, fetch: huge }).complete(request("q"));
    expect(b).toMatchObject({ parsed: null, stopReason: "truncated-input" });
  });
});

describe("route extraction", () => {
  const methods = [
    'import { Meteor } from "meteor/meteor";',
    "",
    "Meteor.methods<ServerMethods>({",
    ...Array.from({ length: 40 }, (_, i) => [`  async "orders.m${i}"(id: string) {`, `    return { id, n: ${i}, padding: "${"x".repeat(60)}" };`, "  },"]).flat(),
    "});",
  ].join("\n");
  const file: SourceFile = { repo: "server", path: "methods.ts", text: methods, components: ["app-server"] };

  it("sends server files with declaration hints only", () => {
    const client: SourceFile = { ...file, path: "ui.ts", components: ["web"] };
    const plain: SourceFile = { ...file, path: "util.ts", text: "export const x = 1;" };
    expect(filesForExtraction([file, client, plain], ["\\.methods\\s*(?:<[^>(]*>)?\\(\\s*\\{"], new Set(["web"])).map((f) => f.path)).toEqual(["methods.ts"]);
  });

  it("splits a long declaration between its properties, repeating the opening line", () => {
    const whole = chunksOf(file, { enabled: false, maxTokens: 300 });
    expect(whole).toHaveLength(1);
    const parts = chunksOf(file, { enabled: true, maxTokens: 400 });
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts.slice(1)) expect(p.code).toMatch(/^\s*3\| Meteor\.methods<ServerMethods>\(\{/);
    // every method line is in exactly one part
    const lines = parts.flatMap((p) => [...p.code.matchAll(/^\s*(\d+)\|\s+async "orders/gm)].map((m) => m[1]));
    expect(lines).toHaveLength(40);
    expect(new Set(lines).size).toBe(40);
  });

  it("turns answers into routes of the method", () => {
    const [chunk] = chunksOf(file, { enabled: false, maxTokens: 1 });
    const answer = {
      parsed: {
        routes: [
          { kind: "ddp-method" as const, method: null, name: "orders.m0", line: 4 },
          { kind: "http" as const, method: "get", name: "api/orders/", line: 999 },
          { kind: "ddp-sub" as const, method: null, name: "notify-room", line: 5 },
        ],
      },
    } as LlmAnswer<{ routes: Array<{ kind: "http" | "ddp-method" | "ddp-sub" | "broker-action"; method: string | null; name: string; line: number }> }>;
    const routes = routesFromAnswer(chunk as never, answer, "qwen");
    expect(routes.map((r) => [r.kind, r.method, r.template, r.line, r.source, r.components[0]])).toEqual([
      ["ddp-method", "call", "orders.m0", 4, "llm", "app-server"],
      ["http", "GET", "/api/orders", (chunk as { lastLine: number }).lastLine, "llm", "app-server"],
      ["ddp-method", "sub", "notify-room", 5, "llm", "app-server"],
    ]);
  });
});

describe("resolution", () => {
  it("shows the code around the call with the call marked", () => {
    const text = ['import a from "a";', ...Array.from({ length: 99 }, (_, i) => `line ${i + 2}`)].join("\n");
    const f = fragmentOf(text, { line: 50, endLine: 51 }, 3);
    expect(f.split("\n")[0]).toMatch(/^\s*1\| import a/);
    expect(f).toMatch(/^>> 50\| line 50$/m);
    expect(f).toMatch(/^ {3}51\| line 51$/m);
    expect(f).not.toMatch(/\| line 40$/m);
  });

  it("reads the choice of a select answer", () => {
    expect(chosen({ choice: "C2", confidence: 1 }, ["a", "b"])).toBe("b");
    expect(chosen({ choice: "NONE", confidence: 1 }, ["a"])).toBeNull();
    expect(chosen({ choice: "C7", confidence: 1 }, ["a"])).toBeNull();
    expect(chosen(null, ["a"])).toBeNull();
  });
});
