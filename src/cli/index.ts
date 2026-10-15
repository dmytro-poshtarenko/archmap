#!/usr/bin/env node
import { Command } from "commander";
import { registerFetch } from "./commands/fetch.js";
import { registerInventory } from "./commands/inventory.js";
import { registerLicenceCheck } from "./commands/licenceCheck.js";
import { registerPin } from "./commands/pin.js";
import { DEFAULT_CONFIG } from "./context.js";

const program = new Command("archmap")
  .description("Recovers inter-service links of multi-repository JS/TS systems and renders them as C4 (LikeC4) diagrams")
  .option("-c, --config <file>", "target config", DEFAULT_CONFIG)
  .option("--data <dir>", "data workspace (default: $ARCHMAP_DATA, else ../data next to the tool)")
  .showHelpAfterError();

registerPin(program);
registerFetch(program);
registerInventory(program);
registerLicenceCheck(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`archmap: ${message}\n`);
  if (process.env.ARCHMAP_DEBUG && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 2;
}
