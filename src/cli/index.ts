#!/usr/bin/env node
import { Command } from "commander";
import { registerCheckRoutes } from "./commands/checkRoutes.js";
import { registerClassify } from "./commands/classify.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerEvaluate } from "./commands/evaluate.js";
import { registerExperiments } from "./commands/exp.js";
import { registerExtract } from "./commands/extract.js";
import { registerExtractInfra } from "./commands/extractInfra.js";
import { registerFetch } from "./commands/fetch.js";
import { registerFreeze } from "./commands/freeze.js";
import { registerInit } from "./commands/init.js";
import { registerInventory } from "./commands/inventory.js";
import { registerLabel } from "./commands/label.js";
import { registerLicenceCheck } from "./commands/licenceCheck.js";
import { registerLlm } from "./commands/llm.js";
import { registerMap } from "./commands/map.js";
import { registerMcp } from "./commands/mcp.js";
import { registerMatch } from "./commands/match.js";
import { registerPin } from "./commands/pin.js";
import { registerRunAll } from "./commands/runAll.js";
import { registerSetup } from "./commands/setup.js";

const program = new Command("archmap")
  .description("Recovers inter-service links of multi-repository JS/TS systems and renders them as C4 (LikeC4) diagrams")
  .option("-c, --config <file>", "project config (default: $ARCHMAP_CONFIG, else archmap.yaml here or in a folder above)")
  .option("--data <dir>", "data folder (default: $ARCHMAP_DATA, else .archmap next to the config)")
  .showHelpAfterError();

registerInit(program);
registerDoctor(program);
registerSetup(program);
registerPin(program);
registerFetch(program);
registerInventory(program);
registerLicenceCheck(program);
registerLabel(program);
registerExtract(program);
registerCheckRoutes(program);
registerExtractInfra(program);
registerClassify(program);
registerMatch(program);
registerEvaluate(program);
registerLlm(program);
registerExperiments(program);
registerMap(program);
registerMcp(program);
registerFreeze(program);
registerRunAll(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`archmap: ${message}\n`);
  if (process.env.ARCHMAP_DEBUG && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 2;
}
