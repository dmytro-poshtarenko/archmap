import type { TargetConfig } from "../../config/schema.js";
import type { Db } from "../../store/db.js";
import type { LlmProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claudeCli.js";
import { OllamaProvider } from "./ollama.js";
import { ReplayProvider } from "./replay.js";

export const MODEL_CHOICES = ["local", "cloud", "cloud-cli", "replay-local", "replay-cloud", "replay-cloud-cli"] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

/** Requests at once: the cloud model takes several, a local model one at a time. */
export function concurrencyOf(choice: ModelChoice): number {
  return choice === "cloud" ? 4 : choice === "cloud-cli" ? 3 : 1;
}

/**
 * The provider of a model choice: `local` (Ollama), `cloud` (Claude through
 * the API), `cloud-cli` (the same Claude through Claude Code on the user's
 * subscription), or the recorded answers of one of them only.
 */
export function providerOf(config: TargetConfig, choice: ModelChoice, db: Db): LlmProvider {
  const { local, cloud } = config.llm;
  switch (choice) {
    case "local":
      return new OllamaProvider(local.model, { url: local.url, seed: local.seed, numCtx: local.numCtx, maxCtx: local.maxCtx });
    case "cloud":
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error("the cloud model needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment");
      }
      return new AnthropicProvider(cloud.model);
    case "cloud-cli":
      return new ClaudeCliProvider(cloud.model);
    case "replay-local":
      return new ReplayProvider(db, { provider: "ollama", model: local.model });
    case "replay-cloud":
      return new ReplayProvider(db, { provider: "anthropic", model: cloud.model });
    case "replay-cloud-cli":
      return new ReplayProvider(db, { provider: "claude-code", model: cloud.model });
  }
}
