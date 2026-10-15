import type { Command } from "commander";
import { toolRoot } from "../../core/paths.js";
import { freeze, freezeProblems } from "../../experiments/freeze.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerFreeze(program: Command): void {
  program
    .command("freeze")
    .description("freeze the method: manifest with hashes, models, the chunking decision and hypothesis 1's predicted shares, committed with an annotated tag")
    .requiredOption("--tag <tag>", "tag of the frozen method, e.g. freeze-1")
    .option("--annotator <id>", "whose test labels give the predicted shares", "A")
    .option("--check", "only list what stops the freeze")
    .action((opts: { tag: string; annotator: string; check?: boolean }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const input = { root: toolRoot, loaded: ctx.loaded, layout: ctx.layout, tag: opts.tag, annotator: opts.annotator };
      if (opts.check) {
        const problems = freezeProblems(input);
        console.log(problems.length === 0 ? "ready to freeze" : `not ready:\n- ${problems.join("\n- ")}`);
        if (problems.length > 0) process.exitCode = 1;
        return;
      }
      const { digest } = freeze(input);
      console.log(digest);
    });
}
