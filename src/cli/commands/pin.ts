import type { Command } from "commander";
import { writeLock } from "../../config/load.js";
import { pinRepos } from "../../workspace/pin.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerPin(program: Command): void {
  program
    .command("pin")
    .description("resolve each remote repository to a commit (git ls-remote) and write <config>.lock.json")
    .option("--repo <ids...>", "only these repositories")
    .option("--refresh", "re-resolve repositories that are already pinned")
    .action((opts: { repo?: string[]; refresh?: boolean }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const result = pinRepos(ctx.loaded.config, ctx.loaded.lock, {
        ids: opts.repo,
        fixed: ctx.loaded.fixedShas,
        refresh: opts.refresh,
      });
      for (const p of result.pinned) console.log(`${p.id}\t${p.ref}\t${p.sha}`);
      if (result.kept.length > 0) ctx.log(`kept existing pins: ${result.kept.join(", ")}`);
      if (result.pinned.length > 0) ctx.log(`wrote ${writeLock(ctx.loaded.path, result.lock)}`);
    });
}
