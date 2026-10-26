import type { ModelUse } from "../config/schema.js";
import type { AvailableModels, Detection } from "./detect.js";

/**
 * Server files the model reads for the declarations the rules miss: routes
 * of Express, Koa and Fastify routers, NestJS controllers and message
 * handlers, Fastify and hapi route objects, Meteor methods and publications.
 */
export const DEFAULT_HINTS = [
  "\\.(?:get|post|put|patch|delete|all|use)\\(\\s*['\"`]/",
  "@(?:Get|Post|Put|Patch|Delete|All|Controller)\\(",
  "@(?:MessagePattern|EventPattern)\\(",
  "\\.route\\(\\s*\\{",
  "\\.methods\\s*(?:<[^>(]*>)?\\(\\s*\\{",
  "\\.publish\\s*(?:<[^>(]*>)?\\(\\s*['\"`]",
];

/** A YAML string: double quotes, as JSON writes them. */
const dq = (s: string) => JSON.stringify(s);
/** A YAML single-quoted string: backslashes stay as they are. */
const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (items: string[]) => `[${items.map(dq).join(", ")}]`;
/** An id as a plain YAML word, quoted when YAML would read it as a number, a boolean or null. */
const word = (s: string) => (/^(true|false|null|~|[-+]?[0-9][0-9._]*)$/i.test(s) ? dq(s) : s);

export interface ModelChoice {
  use: ModelUse;
  /** The Ollama model, when one is chosen or offered. */
  local?: string;
}

/** The config `archmap init` writes: what was found, with a comment on every section and on why each part is there. */
export function renderConfig(d: Detection, choice: ModelChoice, models: AvailableModels, date: string): string {
  const lines = [
    `# archmap configuration for ${d.name}, written by \`archmap init\` on ${date}.`,
    "# Check the parts below, then run `archmap map --open`.",
    `name: ${word(d.name)}`,
    "",
    "# Repositories to read; `path` is relative to this file. A remote one takes `url`",
    "# (github.com/org/repo) instead, and `archmap map` fetches it.",
    "# publishable: true lets the map show the code's addresses and the chosen model read the code.",
    "repos:",
    ...d.repos.map((r) => `  - { id: ${word(r.id)}, path: ${dq(r.path)}, role: main, publishable: true }`),
    "",
    "# The deployed parts. `include` says which code is theirs (`repo:glob`); databases,",
    "# buses and gateways come from the infrastructure and need none. `aliases` are other",
    "# names of a part in the infrastructure.",
    "# kind: client, service, gateway, bus, database, external or scheduler.",
    "components:",
    ...d.components.map((c) => {
      const fields = [
        `id: ${word(c.id)}`,
        `kind: ${c.kind}`,
        ...(c.include.length > 0 ? [`include: ${list(c.include)}`] : []),
        ...(c.exclude.length > 0 ? [`exclude: ${list(c.exclude)}`] : []),
        ...(c.aliases.length > 0 ? [`aliases: ${list(c.aliases)}`] : []),
      ];
      return `  - { ${fields.join(", ")} }  # ${c.why}`;
    }),
    "",
    "# Extraction rules: fetch, axios, BullMQ, amqplib and Express (generic@1); Meteor (meteor@1);",
    "# Rocket.Chat's SDK (rocketchat@1). Calls through an SDK no pack knows are found only by the model.",
    `rules: { packs: [${d.packs.join(", ")}] }`,
    "",
  ];
  const infra = [
    ...(d.infra.compose.length > 0 ? [`  compose: ${list(d.infra.compose)}`] : []),
    ...(d.infra.k8s.length > 0 ? [`  k8s: ${list(d.infra.k8s)}`] : []),
    ...(d.infra.helm.length > 0 ? ["  helm:", ...d.infra.helm.map((h) => `    - { chart: ${dq(h.chart)}, values: ${list(h.values)} }`)] : []),
    ...(d.infra.nginx.length > 0 ? ["  nginx:", ...d.infra.nginx.map((n) => `    - { file: ${dq(n.file)}, gateway: ${word(n.gateway)} }`)] : []),
    ...(d.infra.terraform.length > 0 ? [`  terraform: ${list(d.infra.terraform)}`] : []),
  ];
  lines.push(
    "# How the parts are deployed: container names, environment, gateway routes.",
    ...(infra.length > 0 ? ["infra:", ...infra] : ["# None was found: docker-compose, Kubernetes, Helm, nginx and Terraform files are read when listed here.", "infra: {}"]),
    "",
  );
  const ollama = models.ollama?.chat ?? [];
  const local = choice.use === "local" ? (choice.local ?? ollama[0]) : undefined;
  lines.push(
    "# The language model for what the rules leave open:",
    "#   none       rules and infrastructure only;",
    `#   local      a chat model in Ollama${ollama.length > 0 ? ` (Ollama has: ${ollama.slice(0, 6).join(", ")}${ollama.length > 6 ? ", …" : ""})` : ""};`,
    `#   cloud-cli  Claude through Claude Code${models.claudeCode ? "" : " (not found here)"}; the code goes to Anthropic;`,
    `#   cloud      Claude through ANTHROPIC_API_KEY${models.apiKey ? "" : " (not set here)"}; the code goes to Anthropic.`,
    "llm:",
    `  use: ${choice.use}`,
    ...(local ? [`  local: { model: ${dq(local)} }`] : ollama.length > 0 ? [`  # local: { model: ${dq(choice.local ?? ollama[0] ?? "")} }`] : []),
    "  # Server files the model reads for declarations the rules miss.",
    "  extract:",
    "    hints:",
    ...DEFAULT_HINTS.map((h) => `      - ${sq(h)}`),
    "",
  );
  return lines.join("\n");
}
