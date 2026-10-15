import { resolve } from "node:path";
import type { Command } from "commander";
import { toolRoot } from "../../core/paths.js";
import { licenceCheck } from "../../workspace/licenceCheck.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerLicenceCheck(program: Command): void {
  program
    .command("licence-check")
    .description("fail if any file under --scan repeats code from a zone that may not be published (Rocket.Chat EE, helm-charts)")
    .option("--scan <dir>", "directory to check (git-tracked and untracked-not-ignored files)", toolRoot)
    .action((opts: { scan: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const heldout = new Set(ctx.loaded.config.repos.filter((r) => r.role === "heldout").map((r) => r.id));
      const result = licenceCheck(ctx.loaded.config, ctx.layout, ctx.loaded.path, {
        scanRoot: resolve(opts.scan),
        allowHeldout: heldout.size > 0 && ctx.frozen(),
        log: ctx.log,
      });
      for (const r of result.protectedRepos) {
        ctx.log(`${r.id}: ${r.fingerprints} fingerprints from ${r.files} protected files${r.cached ? " (cached)" : ""}`);
      }
      const missing = result.unavailable.filter((id) => !heldout.has(id));
      if (missing.length > 0) {
        throw new Error(`cannot check against ${missing.join(", ")}: not fetched; run 'archmap fetch' first`);
      }
      for (const f of result.findings) console.log(`${f.file}:${f.startLine}-${f.endLine}\tmatches ${f.source}`);
      if (result.findings.length > 0) {
        ctx.log(`licence-check: ${result.findings.length} protected fragment(s) found in ${result.scanned} files`);
        process.exitCode = 1;
      } else {
        ctx.log(`licence-check: ok, ${result.scanned} files scanned`);
      }
    });
}
