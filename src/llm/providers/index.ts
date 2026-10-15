import type { TargetConfig } from "../../config/schema.js";
import type { Db } from "../../store/db.js";
import type { LlmProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { ReplayProvider } from "./replay.js";

export type ModelChoice = "local" | "cloud" | "replay-local" | "replay-cloud";

/** The provider of a model choice: `local` (Ollama), `cloud` (Claude), or their recorded answers only. */
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
    case "replay-local":
      return new ReplayProvider(db, { provider: "ollama", model: local.model });
    case "replay-cloud":
      return new ReplayProvider(db, { provider: "anthropic", model: cloud.model });
  }
}
