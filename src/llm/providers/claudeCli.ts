import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LlmAnswer, LlmProvider, LlmRequest, Usage } from "../types.js";
import { parseAnswer } from "./ollama.js";

/** Runs a command with the given standard input in the given directory. */
export type RunCommand = (cmd: string, args: string[], opts: { cwd: string; input: string; timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export function runCommand(): RunCommand {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code });
      });
      child.stdin.end(opts.input);
    });
}

interface CliResult {
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

/** Arguments of one print-mode session that sees only the request. */
export function cliArgs(model: string, req: LlmRequest, systemFile: string): string[] {
  return [
    "-p",
    "--model", model,
    "--system-prompt-file", systemFile,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--effort", req.effort,
    "--output-format", "json",
    // Claude Code validates the schema as draft-07 and refuses the 2020-12 dialect zod writes by default
    "--json-schema", JSON.stringify(z.toJSONSchema(req.schema, { target: "draft-7" })),
  ];
}

/**
 * The cloud model through Claude Code in print mode, on the user's
 * subscription instead of the API. Each request is a fresh session in an
 * empty directory: our system prompt replaces Claude Code's, with no tools,
 * no MCP servers, no settings (so no hooks) and no saved session. Checked
 * live on Claude Code 2.1.303: the model then sees our prompt and one short
 * reminder with the account's e-mail. Unlike the API there is no batch and
 * no output limit to set; the answer is still checked against the schema.
 *
 * A refusal or an answer outside the schema is recorded as "no link", as
 * with the other providers. An error of the service (a usage limit, an
 * outage, no login) is thrown, so nothing is cached and a later run asks again.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly id = "claude-code" as const;
  private readonly run: RunCommand;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(
    readonly model: string,
    opts: { bin?: string; timeoutMs?: number; run?: RunCommand } = {},
  ) {
    this.bin = opts.bin ?? "claude";
    this.timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    this.run = opts.run ?? runCommand();
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    const t0 = performance.now();
    const dir = mkdtempSync(join(tmpdir(), "archmap-claude-"));
    try {
      writeFileSync(join(dir, "system.md"), req.system);
      const { stdout, stderr, code } = await this.run(this.bin, cliArgs(this.model, req, "system.md"), { cwd: dir, input: req.user, timeoutMs: this.timeoutMs });
      let data: CliResult;
      try {
        data = JSON.parse(stdout) as CliResult;
      } catch {
        throw new Error(`claude: no result (exit ${code}): ${(stderr || stdout).trim().slice(0, 300)}`);
      }
      const modelActual = Object.keys(data.modelUsage ?? {})[0] ?? null;
      const usage = usageOf(data, modelActual);
      if (data.stop_reason === "refusal") return this.answer(req, t0, data.result ?? "", modelActual, "refusal", usage);
      if (data.is_error || data.subtype !== "success") {
        // the model's own failure to give a structured answer is an answer; anything else is the service's
        if (data.subtype?.startsWith("error_max") && !data.api_error_status) return this.answer(req, t0, data.result ?? "", modelActual, data.subtype, usage);
        throw new Error(`claude: ${data.subtype ?? "error"}${data.api_error_status ? ` ${data.api_error_status}` : ""}: ${(data.result ?? stderr).trim().slice(0, 300)}`);
      }
      const raw = data.structured_output !== undefined ? JSON.stringify(data.structured_output) : (data.result ?? "");
      return this.answer(req, t0, raw, modelActual, "end_turn", usage);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private answer<T>(req: LlmRequest<T>, t0: number, raw: string, model: string | null, stop: string, usage: Usage): LlmAnswer<T> {
    return {
      parsed: stop === "end_turn" ? parseAnswer(req.schema, raw) : null,
      raw,
      stopReason: stop,
      modelRequested: this.model,
      modelActual: model,
      usage,
      latencyMs: performance.now() - t0,
      // the subscription is not billed per request
      costUsd: 0,
      cached: false,
      batchId: null,
    };
  }
}

function usageOf(data: CliResult, model: string | null): Usage {
  const u = model ? data.modelUsage?.[model] : undefined;
  return { input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens ?? 0, cacheWrite: u?.cacheCreationInputTokens ?? 0 };
}
