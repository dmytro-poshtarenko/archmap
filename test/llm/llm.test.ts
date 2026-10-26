import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cacheKey } from "../../src/llm/cache.js";
import { LlmClient, repeatsOf } from "../../src/llm/client.js";
import { loadTemplate, render, TEMPLATES } from "../../src/llm/prompts.js";
import { ClaudeCliProvider, type RunCommand } from "../../src/llm/providers/claudeCli.js";
import { errorOf, infoOf, OllamaProvider, windowFor } from "../../src/llm/providers/ollama.js";
import { ReplayProvider } from "../../src/llm/providers/replay.js";
import { decisionOf } from "../../src/llm/stats.js";
import { chunksOf, filesForExtraction, RouteAnswer, routesFromAnswer, type SourceFile } from "../../src/llm/tasks/extractRoutes.js";
import { ProbeAnswer } from "../../src/llm/tasks/probe.js";
import { chosen, FreeAnswer, fragmentOf, SelectAnswer } from "../../src/llm/tasks/resolve.js";
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
    const t = loadTemplate(TEMPLATES.select);
    expect(t.id).toBe("resolve-select");
    expect(render("{{a}} and {{b}}", { a: "x", b: "y" })).toBe("x and y");
    expect(() => render("{{missing}}", {})).toThrow(/missing/);
  });

  // Ollama constrains decoding to the schema without showing it to the model.
  // Told only "DDP methods" in prose, qwen3 answered `http` for every
  // Meteor method; naming the values in the prompt fixed it.
  it("name every field and value of their answer", () => {
    const wordsOf = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(wordsOf);
      if (node === null || typeof node !== "object") return [];
      const o = node as { properties?: object; enum?: unknown[] };
      const values = (o.enum ?? []).filter((v): v is string => typeof v === "string");
      return [...Object.keys(o.properties ?? {}), ...values, ...Object.values(o).flatMap(wordsOf)];
    };
    const answers = [
      [TEMPLATES.extract, RouteAnswer],
      [TEMPLATES.select, SelectAnswer],
      [TEMPLATES.free, FreeAnswer],
      [TEMPLATES.probe, ProbeAnswer],
    ] as const;
    for (const [ref, schema] of answers) {
      const system = loadTemplate(ref).system;
      for (const word of new Set(wordsOf(z.toJSONSchema(schema)))) expect(system, `${ref} does not name ${word}`).toContain(`\`${word}\``);
    }
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

/** Ollama as the tests need it: `/api/show` describes the model (by default a thinking one with a long context), `/api/chat` answers as given. */
const ollama =
  (chat: (url: string, body: unknown) => Promise<unknown>, show: unknown = { capabilities: ["completion", "thinking"], model_info: { "qwen3moe.context_length": 262144 } }) =>
  async (url: string, body: unknown) =>
    url.endsWith("/api/show") ? show : chat(url, body);

describe("the Ollama provider", () => {
  it("never cuts the input: a refused prompt is sent again with a window that fits", async () => {
    const windows: number[] = [];
    const fake = async (_url: string, payload: unknown) => {
      const body = payload as { options: { num_ctx: number; temperature: number; seed: number } };
      windows.push(body.options.num_ctx);
      expect(body.options).toMatchObject({ temperature: 0, seed: 42 });
      if (body.options.num_ctx < 13932 + 100) {
        // as Ollama 0.40 sends it: the server's error as a JSON string
        return { error: JSON.stringify({ error: { code: 400, type: "exceed_context_size_error", message: "too long", n_prompt_tokens: 13932, n_ctx: body.options.num_ctx } }) };
      }
      return { model: "qwen", message: { content: '{"value":"ok"}' }, done_reason: "stop", prompt_eval_count: 13932, eval_count: 4 };
    };
    const p = new OllamaProvider("qwen", { url: "http://x", seed: 42, numCtx: 4096, maxCtx: 131072, post: ollama(fake) });
    const a = await p.complete(request("long"));
    expect(a.parsed).toEqual({ value: "ok" });
    expect(a.usage.input).toBe(13932);
    expect(windows).toEqual([4096, windowFor(13932, 100, 131072)]);
  });

  it("counts a long prompt exactly and widens a window the answer filled", async () => {
    const windows: number[] = [];
    const fake = async (_url: string, payload: unknown) => {
      const n = (payload as { options: { num_ctx: number } }).options.num_ctx;
      windows.push(n);
      // a one-token window is refused with the exact count; that count is far above the estimate
      if (n === 1) return { error: JSON.stringify({ error: { type: "exceed_context_size_error", n_prompt_tokens: 20000, n_ctx: 1 } }) };
      // the first real request filled its window to the last token
      if (windows.length === 2) return { model: "qwen", message: { content: '{"value":"x"}' }, done_reason: "stop", prompt_eval_count: 20000, eval_count: n - 20000 };
      return { model: "qwen", message: { content: '{"value":"ok"}' }, done_reason: "stop", prompt_eval_count: 20000, eval_count: 50 };
    };
    const long = { ...request("x".repeat(30000)), maxTokens: 100 };
    const a = await new OllamaProvider("qwen", { url: "http://x", seed: 1, numCtx: "auto", maxCtx: 131072, post: ollama(fake) }).complete(long);
    expect(windows[0]).toBe(1);
    expect(windows[1]).toBe(windowFor(20000, 100, 131072));
    expect(windows[2]).toBeGreaterThan(windows[1] as number);
    expect(a.parsed).toEqual({ value: "ok" });
  });

  // Ollama 0.40.2 itself refuses in plain text, and raises a one-token window to 256.
  // Read as an unknown error, the count fell back to the estimate (8.5k tokens short on
  // numbered code), and the refusal of the real request stopped the H3 run.
  it("reads Ollama's plain-text refusal: counts exactly and sizes the window", async () => {
    const tokens = 98485;
    const windows: number[] = [];
    const fake = async (_url: string, payload: unknown) => {
      const n = (payload as { options: { num_ctx: number } }).options.num_ctx;
      windows.push(n);
      if (n < tokens + 100) return { error: `request (${tokens} tokens) exceeds the available context size (${Math.max(256, n)} tokens), try increasing it` };
      return { model: "qwen", message: { content: '{"value":"ok"}' }, done_reason: "stop", prompt_eval_count: tokens, eval_count: 20 };
    };
    const long = { ...request("x".repeat(30000)), maxTokens: 100 };
    const a = await new OllamaProvider("qwen", { url: "http://x", seed: 1, numCtx: "auto", maxCtx: 131072, post: ollama(fake) }).complete(long);
    expect(windows).toEqual([1, windowFor(tokens, 100, 131072)]);
    expect(a).toMatchObject({ parsed: { value: "ok" }, stopReason: "end_turn" });
    expect(errorOf("model not found")).toEqual({ message: "model not found" });
  });

  it("reports a cut answer and an input beyond the largest window", async () => {
    const cut = async () => ({ model: "qwen", message: { content: '{"val' }, done_reason: "length", prompt_eval_count: 10, eval_count: 100 });
    const a = await new OllamaProvider("qwen", { url: "http://x", seed: 1, numCtx: "auto", maxCtx: 8192, post: ollama(cut) }).complete(request("q"));
    expect(a).toMatchObject({ parsed: null, stopReason: "max_tokens" });
    const huge = async () => ({ error: { type: "exceed_context_size_error", n_prompt_tokens: 50000, n_ctx: 8192 } });
    const b = await new OllamaProvider("qwen", { url: "http://x", seed: 1, numCtx: 8192, maxCtx: 8192, post: ollama(huge) }).complete(request("q"));
    expect(b).toMatchObject({ parsed: null, stopReason: "truncated-input" });
  });

  it("works with any chat model Ollama has: no thinking option for a model that does not think, no window beyond its context", async () => {
    const bodies: Array<{ think?: boolean; options: { num_ctx: number } }> = [];
    const chat = async (_url: string, payload: unknown) => {
      const body = payload as { think?: boolean; options: { num_ctx: number } };
      bodies.push(body);
      if (body.options.num_ctx === 1) return { error: JSON.stringify({ error: { type: "exceed_context_size_error", n_prompt_tokens: 6000, n_ctx: 1 } }) };
      return { error: JSON.stringify({ error: { type: "exceed_context_size_error", n_prompt_tokens: 6000, n_ctx: body.options.num_ctx } }) };
    };
    // a small model trained on 4096 tokens, without thinking
    const show = { capabilities: ["completion", "tools"], model_info: { "llama.context_length": 4096 } };
    const long = { ...request("x".repeat(30000)), maxTokens: 100 };
    const a = await new OllamaProvider("llama3.2:3b", { url: "http://x", seed: 1, numCtx: "auto", maxCtx: 131072, post: ollama(chat, show) }).complete(long);
    expect(bodies.every((b) => !("think" in b))).toBe(true);
    expect(Math.max(...bodies.map((b) => b.options.num_ctx))).toBeLessThanOrEqual(4096);
    expect(a).toMatchObject({ parsed: null, stopReason: "truncated-input" });
    // a model that thinks is told not to
    const thinking: Array<{ think?: boolean }> = [];
    const answer = async (_url: string, payload: unknown) => {
      thinking.push(payload as { think?: boolean });
      return { model: "qwen3", message: { content: '{"value":"ok"}' }, done_reason: "stop", prompt_eval_count: 10, eval_count: 4 };
    };
    await new OllamaProvider("qwen3", { url: "http://x", seed: 1, numCtx: "auto", maxCtx: 131072, post: ollama(answer) }).complete(request("q"));
    expect(thinking.map((b) => b.think)).toEqual([false]);
  });

  it("says what to do when the model is not pulled, cannot chat, or Ollama is not running", async () => {
    expect(() => infoOf("llama3.2:3b", { error: 'model "llama3.2:3b" not found, try pulling it first' })).toThrow("pull it with `ollama pull llama3.2:3b`");
    expect(() => infoOf("nomic-embed-text", { capabilities: ["embedding"] })).toThrow('"nomic-embed-text" cannot chat');
    // an Ollama that does not report capabilities: the old behaviour, with the configured window
    expect(infoOf("m", {})).toEqual({ thinking: null, contextLength: null });
    const down = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };
    await expect(new OllamaProvider("m", { url: "http://127.0.0.1:11434", seed: 1, numCtx: "auto", maxCtx: 8192, post: down }).complete(request("q"))).rejects.toThrow("start it with `ollama serve`");
  });
});

describe("the Claude Code provider (subscription)", () => {
  const usage = { "claude-opus-5-5": { inputTokens: 2, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 1500 } };
  const success = (structured: unknown) => ({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(structured), structured_output: structured, stop_reason: "tool_use", modelUsage: usage }),
    stderr: "",
    code: 0,
  });

  it("sends only the request: our system prompt, no tools, no MCP servers, no settings", async () => {
    const seen: Array<{ args: string[]; cwd: string; input: string; system: string }> = [];
    const run: RunCommand = async (_cmd, args, opts) => {
      seen.push({ args, cwd: opts.cwd, input: opts.input, system: readFileSync(join(opts.cwd, "system.md"), "utf8") });
      return success({ value: "ok" });
    };
    const provider = new ClaudeCliProvider("claude-opus-5-5", { run });
    const a = await provider.complete({ ...request("the user part"), system: "the system part" });
    expect(a).toMatchObject({ parsed: { value: "ok" }, stopReason: "end_turn", modelActual: "claude-opus-5-5", costUsd: 0, usage: { input: 2, output: 40, cacheRead: 0, cacheWrite: 1500 } });
    const [s] = seen;
    if (!s) throw new Error("no call");
    const flag = (name: string) => s.args[s.args.indexOf(name) + 1];
    expect([s.input, s.system]).toEqual(["the user part", "the system part"]);
    expect([flag("--tools"), flag("--setting-sources"), flag("--model"), flag("--effort")]).toEqual(["", "", "claude-opus-5-5", "low"]);
    expect(s.args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--no-session-persistence"]));
    expect(JSON.parse(flag("--json-schema") as string)).toMatchObject({ type: "object", properties: { value: { type: "string" } } });
    // every request is a fresh session in an empty directory, removed afterwards
    expect(existsSync(s.cwd)).toBe(false);
    // the same cloud model, so its runs carry the cloud tag
    expect(new LlmClient(openDb(":memory:"), provider, { budgetUsd: 1 }).tag).toBe("cloud");
  });

  it("records a refusal as no answer, and throws on an error of the service so nothing is cached", async () => {
    const refusal: RunCommand = async () => ({ stdout: JSON.stringify({ subtype: "success", is_error: false, stop_reason: "refusal", result: "no" }), stderr: "", code: 0 });
    expect(await new ClaudeCliProvider("m", { run: refusal }).complete(request("q"))).toMatchObject({ parsed: null, stopReason: "refusal" });
    const limit: RunCommand = async () => ({ stdout: JSON.stringify({ subtype: "success", is_error: true, api_error_status: 429, result: "usage limit reached" }), stderr: "", code: 1 });
    await expect(new ClaudeCliProvider("m", { run: limit }).complete(request("q"))).rejects.toThrow(/429/);
    const noLogin: RunCommand = async () => ({ stdout: "", stderr: "not logged in", code: 1 });
    await expect(new ClaudeCliProvider("m", { run: noLogin }).complete(request("q"))).rejects.toThrow(/not logged in/);
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
