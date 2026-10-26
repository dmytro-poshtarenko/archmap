import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { load as parseYaml } from "js-yaml";
import { parseConfig } from "../../config/load.js";
import { MODEL_USES, type ModelUse } from "../../config/schema.js";
import { CONFIG_FILE } from "../../core/paths.js";
import { type AvailableModels, availableModels, detect } from "../../init/detect.js";
import { type ModelChoice, renderConfig } from "../../init/write.js";

interface InitOptions {
  model?: string;
  localModel?: string;
  yes?: boolean;
  print?: boolean;
  force?: boolean;
}

async function ask(question: string, answers: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const raw = (await rl.question(`${question}\n${answers.map((a, i) => `  ${i + 1}) ${a}`).join("\n")}\nChoice [1]: `)).trim();
      const n = raw === "" ? 1 : Number.parseInt(raw, 10);
      if (n >= 1 && n <= answers.length) return n - 1;
    }
  } finally {
    rl.close();
  }
}

/** The model the config names: from the options, else asked in a terminal, else none. */
async function chooseModel(models: AvailableModels, opts: InitOptions): Promise<ModelChoice> {
  const chat = models.ollama?.chat ?? [];
  if (opts.model !== undefined) {
    if (!MODEL_USES.includes(opts.model as ModelUse)) throw new Error(`unknown model '${opts.model}': ${MODEL_USES.join(", ")}`);
    const use = opts.model as ModelUse;
    const local = opts.localModel ?? chat[0];
    if (use === "local" && !local) throw new Error("Ollama has no chat model here: pull one (`ollama pull llama3.1:8b`), or name it with --local-model");
    return { use, local };
  }
  if (opts.yes || !process.stdin.isTTY) return { use: "none", local: opts.localModel };
  const offers: Array<{ label: string; choice: () => Promise<ModelChoice> }> = [{ label: "none: rules and infrastructure only", choice: async () => ({ use: "none", local: chat[0] }) }];
  if (chat.length > 0) {
    offers.push({
      label: `local: a chat model in Ollama (${chat.length === 1 ? chat[0] : `${chat.length} models`}); the code stays on this computer`,
      choice: async () => ({ use: "local", local: chat.length === 1 ? chat[0] : chat[await ask("Which Ollama model?", chat)] }),
    });
  }
  if (models.claudeCode) offers.push({ label: "cloud-cli: Claude through Claude Code; the code goes to Anthropic", choice: async () => ({ use: "cloud-cli", local: chat[0] }) });
  if (models.apiKey) offers.push({ label: "cloud: Claude through ANTHROPIC_API_KEY; the code goes to Anthropic", choice: async () => ({ use: "cloud", local: chat[0] }) });
  if (offers.length === 1) return { use: "none" };
  const picked = offers[await ask("Which language model should resolve what the rules leave open?", offers.map((o) => o.label))] as (typeof offers)[number];
  return picked.choice();
}

export function registerInit(program: Command): void {
  program
    .command("init [dir]")
    .description("write archmap.yaml for a project: its repositories, deployed parts, databases, buses, gateways and infrastructure files, and a model this computer offers")
    .option("--model <model>", "none, local (Ollama), cloud-cli (Claude Code) or cloud (API key); default: asked in a terminal, else none")
    .option("--local-model <name>", "the Ollama model for --model local (default: the first chat model Ollama has)")
    .option("-y, --yes", "ask nothing and take the defaults")
    .option("--print", "print the config instead of writing it")
    .option("--force", "replace an archmap.yaml that exists")
    .action(async (dirArg: string | undefined, opts: InitOptions) => {
      const dir = resolve(dirArg ?? ".");
      const file = join(dir, CONFIG_FILE);
      if (existsSync(file) && !opts.force && !opts.print) throw new Error(`${file} exists: check it and run \`archmap map\`, or replace it with --force`);
      const found = detect(dir);
      const models = await availableModels();
      const choice = await chooseModel(models, opts);
      const text = renderConfig(found, choice, models, new Date().toISOString().slice(0, 10));
      // the written config must load as every command loads it
      parseConfig(parseYaml(text), file);
      if (opts.print) {
        process.stdout.write(text);
        return;
      }
      writeFileSync(file, text);
      const kinds = (kind: string) => found.components.filter((c) => c.kind === kind).map((c) => c.id);
      const names: Record<string, [string, string]> = {
        compose: ["docker-compose file", "docker-compose files"],
        k8s: ["Kubernetes manifest", "Kubernetes manifests"],
        helm: ["Helm chart", "Helm charts"],
        nginx: ["nginx config", "nginx configs"],
        terraform: ["Terraform folder", "Terraform folders"],
      };
      const infraFiles = Object.entries(found.infra)
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => `${v.length} ${(names[k] ?? [k, k])[v.length === 1 ? 0 : 1]}`);
      const plural: Record<string, string> = { client: "clients", service: "services", gateway: "gateways", bus: "buses", database: "databases" };
      console.log(`Found in ${dir}:`);
      console.log(`  repositories: ${found.repos.map((r) => `${r.id} (${r.path})`).join(", ")}`);
      for (const kind of Object.keys(plural)) if (kinds(kind).length > 0) console.log(`  ${plural[kind]}: ${kinds(kind).join(", ")}`);
      console.log(`  infrastructure: ${infraFiles.length > 0 ? infraFiles.join(", ") : "none found"}`);
      console.log(`  rules: ${found.packs.join(", ")}`);
      console.log(`  model: ${choice.use}${choice.use === "local" ? ` (${choice.local})` : ""}`);
      console.log(`Wrote ${file}. Check the parts in it, then run \`archmap map --open\`.`);
    });
}
