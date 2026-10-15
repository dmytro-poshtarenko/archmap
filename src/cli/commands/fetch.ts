import type { Command } from "commander";
import { fetchRepos } from "../../workspace/fetch.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerFetch(program: Command): void {
  program
    .command("fetch")
    .description("check out every repository at its pinned commit under data/repos (the held-out one only after the freeze)")
    .option("--repo <ids...>", "only these repositories")
    .action((opts: { repo?: string[] }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const needsGuard = ctx.loaded.config.repos.some((r) => r.role === "heldout");
      const results = fetchRepos(ctx.loaded.config, ctx.layout, ctx.loaded.path, {
        ids: opts.repo,
        allowHeldout: needsGuard && ctx.frozen(),
        log: ctx.log,
      });
      for (const r of results) console.log(`${r.id}\t${r.status}${r.dir ? `\t${r.dir}` : ""}`);
    });
}
