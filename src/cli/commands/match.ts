import type { Command } from "commander";
import { classificationCurrent, runClassify } from "../../classify/run.js";
import { runMatch } from "../../match/run.js";
import { createContext, type GlobalOptions } from "../context.js";

interface MatchOptions {
  rules: boolean;
  infra: boolean;
  llm: boolean;
}

export function registerMatch(program: Command): void {
  program
    .command("match")
    .description("match call sites to routes and parts of the system for one variant of the method; stores the run")
    .option("--no-rules", "variant without the rules: rule-based addresses and route declarations are hidden")
    .option("--no-infra", "variant without the infrastructure descriptions")
    .option("--no-llm", "variant without the language model")
    .action((opts: MatchOptions, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      const db = ctx.openDb();
      try {
        if (!classificationCurrent(db, config)) {
          ctx.log("cases are missing or out of date; classifying first");
          runClassify(db, config);
        }
        const s = runMatch(db, config, { rules: opts.rules, infra: opts.infra, llm: opts.llm }, { configHash: ctx.loaded.hash });
        const list = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
        console.log(`run ${s.run}: ${s.sites} call sites in ${s.seconds}s`);
        console.log(`status: ${list(s.byStatus)}`);
        console.log(`linked by type: ${list(s.linkedByType)}`);
        console.log(`decided by: ${list(s.byProvenance)}`);
      } finally {
        db.close();
      }
    });
}
