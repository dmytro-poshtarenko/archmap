import type { Command } from "commander";
import { runClassify } from "../../classify/run.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerClassify(program: Command): void {
  program
    .command("classify")
    .description("predict the case of every call site from the full evidence (rules, infrastructure, extracted declarations)")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        const s = runClassify(db, ctx.loaded.config);
        console.log(`${s.sites} call sites classified in ${s.seconds}s`);
        console.log(`by case: ${Object.entries(s.byCase).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        console.log(`full resolution: ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      } finally {
        db.close();
      }
    });
}
