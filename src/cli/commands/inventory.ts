import type { Command } from "commander";
import { runInventory } from "../../workspace/inventory.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerInventory(program: Command): void {
  program
    .command("inventory")
    .description("describe every file: hash, code unit, component, licence zone and dev/test split")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const needsGuard = ctx.loaded.config.repos.some((r) => r.role === "heldout");
      const db = ctx.openDb();
      try {
        const result = runInventory(db, ctx.loaded.config, ctx.layout, ctx.loaded.path, {
          allowHeldout: needsGuard && ctx.frozen(),
          configHash: ctx.loaded.hash,
          log: ctx.log,
        });
        console.log("repo\tsha\tfiles\tunits\tdev\ttest\theldout");
        for (const r of result.repos) {
          const s = r.splits;
          console.log(`${r.id}\t${r.sha.slice(0, 12)}\t${r.files}\t${r.units}\t${s.dev}\t${s.test}\t${s.heldout}`);
        }
        console.log(`inventory hash ${result.hash}`);
        ctx.log(`database ${ctx.dbPath}`);
      } finally {
        db.close();
      }
    });
}
