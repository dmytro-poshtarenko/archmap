import type { Command } from "commander";
import { programOf, runExtraction } from "../../extract/run.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerExtract(program: Command): void {
  program
    .command("extract")
    .description("find call sites and route declarations with the rule packs (once per snapshot and rules)")
    .option("--force", "run even if neither the inventory nor the rules changed")
    .action((opts: { force?: boolean }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        const stats = runExtraction(db, ctx.loaded.config, programOf(db, ctx.loaded.config, ctx.layout, ctx.loaded.path), {
          force: opts.force,
          log: ctx.log,
        });
        if (stats.skipped) ctx.log("inventory and rules unchanged since the last run; use --force to run again");
        console.log(`${stats.sites} call sites (${stats.lifted} lifted from wrappers), ${stats.routes} routes in ${stats.files} code files`);
        console.log(`by type: ${Object.entries(stats.byType).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
        console.log(`by detector: ${Object.entries(stats.byDetector).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
        const s = stats.seconds;
        console.log(`time: parse ${s.parse}s, calls ${s.calls}s, lifting ${s.lift}s, routes ${s.routes}s, total ${s.total}s; memory ${stats.rssMb} MB`);
      } finally {
        db.close();
      }
    });
}
