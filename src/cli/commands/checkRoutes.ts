import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { compareRoutes, typedRoutes } from "../../eval/restTypings.js";
import { loadRoutes, programOf } from "../../extract/run.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerCheckRoutes(program: Command): void {
  program
    .command("check-routes")
    .description("compare the REST routes found by the rules with the typed catalog (rest-typings); reference only")
    .option("--repo <id>", "repository holding the catalog", "main")
    .action((opts: { repo: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        const typed = typedRoutes(programOf(db, ctx.loaded.config, ctx.layout, ctx.loaded.path), opts.repo);
        const result = compareRoutes(typed, loadRoutes(db).filter((r) => r.source === "rules"));
        const lines = [
          `# REST routes found by the rules vs rest-typings`,
          "",
          `Typed routes: ${result.typed}. Found by the rules: ${result.found} (${(result.recall * 100).toFixed(1)} %).`,
          `Routes the rules found that rest-typings does not type: ${result.untyped.length}.`,
          "",
          "## Typed but not found",
          "",
          ...result.missing.map((m) => `- \`${m.method} ${m.path}\` (${m.at})`),
          "",
          "## Found but not typed",
          "",
          ...result.untyped.map((r) => `- \`${r.method} ${r.template}\` (${r.repo}:${r.path}:${r.line})`),
          "",
        ];
        const dir = join(ctx.layout.root, "reports", ctx.loaded.config.name);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "routes-vs-rest-typings.md");
        writeFileSync(file, lines.join("\n"));
        console.log(`typed ${result.typed}, found ${result.found}, recall ${(result.recall * 100).toFixed(1)} %; untyped ${result.untyped.length}`);
        ctx.log(`report: ${file}`);
      } finally {
        db.close();
      }
    });
}
