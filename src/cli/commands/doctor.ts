import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { Command } from "commander";
import { type LoadedConfig, loadConfig } from "../../config/load.js";
import type { ModelUse } from "../../config/schema.js";
import { dataLayout, resolveConfigPath, resolveDataDir } from "../../core/paths.js";
import { OllamaProvider } from "../../llm/providers/ollama.js";
import { locateRepo } from "../../workspace/repos.js";
import type { GlobalOptions } from "../context.js";

export interface Check {
  ok: boolean;
  what: string;
  /** What to do when the check fails. */
  fix?: string;
}

/** The node version needed, from package.json's engines. */
const NODE_MAJOR = 24;

/** Whether the computer can run archmap on a project: the tools, the config, its repositories and data folder, the model. */
export async function doctorChecks(opts: GlobalOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ ok: major >= NODE_MAJOR, what: `Node.js ${process.versions.node}`, fix: `install Node.js ${NODE_MAJOR} or newer` });
  try {
    const version = (createRequire(import.meta.url)("likec4/package.json") as { version: string }).version;
    checks.push({ ok: true, what: `LikeC4 ${version}` });
  } catch {
    checks.push({ ok: false, what: "LikeC4", fix: "reinstall archmap: its dependencies are missing" });
  }
  let loaded: LoadedConfig | null = null;
  try {
    loaded = loadConfig(resolveConfigPath(opts.config));
    const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    checks.push({ ok: true, what: `config ${loaded.path} (${loaded.config.name}: ${n(loaded.config.repos.length, "repository", "repositories")}, ${n(loaded.config.components.length, "part", "parts")})` });
  } catch (error) {
    checks.push({ ok: false, what: "config", fix: error instanceof Error ? error.message : String(error) });
    return checks;
  }
  const layout = dataLayout(resolveDataDir(opts.data, loaded.path));
  try {
    mkdirSync(layout.root, { recursive: true });
    accessSync(layout.root, constants.W_OK);
    checks.push({ ok: true, what: `data folder ${layout.root}` });
  } catch {
    checks.push({ ok: false, what: `data folder ${layout.root}`, fix: "name a folder you can write to with --data or ARCHMAP_DATA" });
  }
  const needsGit = loaded.config.repos.some((r) => r.url !== undefined);
  if (needsGit) checks.push({ ok: spawnSync("git", ["--version"]).status === 0, what: "git, for the remote repositories", fix: "install git" });
  for (const repo of loaded.config.repos) {
    if (repo.role === "heldout") continue;
    const loc = locateRepo(repo, layout, loaded.path);
    if (repo.path !== undefined) checks.push({ ok: existsSync(loc.dir), what: `repository ${repo.id} at ${loc.dir}`, fix: `fix its path in ${loaded.path}` });
    else checks.push({ ok: true, what: `repository ${repo.id}: ${loc.present ? "fetched" : "fetched by `archmap map`"}` });
  }
  const use: ModelUse = loaded.config.llm.use ?? "none";
  if (use === "local") {
    try {
      const info = await new OllamaProvider(loaded.config.llm.local.model, { ...loaded.config.llm.local, numCtx: "auto" }).modelInfo();
      checks.push({ ok: true, what: `Ollama model ${loaded.config.llm.local.model}${info.contextLength ? `, context ${info.contextLength}` : ""}` });
    } catch (error) {
      checks.push({ ok: false, what: `Ollama model ${loaded.config.llm.local.model}`, fix: error instanceof Error ? error.message.replace(/^ollama: /, "") : String(error) });
    }
  } else if (use === "cloud-cli") {
    checks.push({ ok: spawnSync("claude", ["--version"]).status === 0, what: "Claude Code (`claude`), for the cloud model", fix: "install Claude Code and log in, or set llm.use to local or none" });
  } else if (use === "cloud") {
    checks.push({ ok: Boolean(process.env.ANTHROPIC_API_KEY), what: "ANTHROPIC_API_KEY, for the cloud model", fix: "set ANTHROPIC_API_KEY, or set llm.use to cloud-cli, local or none" });
  } else {
    checks.push({ ok: true, what: "model: none (rules and infrastructure only; set llm.use to add one)" });
  }
  return checks;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check that this computer can run archmap on the project: Node.js, LikeC4, the config, its repositories and data folder, the model")
    .action(async (_opts: unknown, cmd: Command) => {
      const checks = await doctorChecks(cmd.optsWithGlobals<GlobalOptions>());
      for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.what}${c.ok || !c.fix ? "" : `\n     ${c.fix}`}`);
      const failed = checks.filter((c) => !c.ok).length;
      console.log(failed === 0 ? "Everything is in place: run `archmap map --open`." : `${failed} problem${failed === 1 ? "" : "s"} to fix.`);
      if (failed > 0) process.exitCode = 1;
    });
}
