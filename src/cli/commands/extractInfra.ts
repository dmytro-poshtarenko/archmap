import type { Command } from "commander";
import { hashOf } from "../../core/hash.js";
import { extractInfra, writeInfra } from "../../infra/index.js";
import { getMeta } from "../../store/db.js";
import { locateRepo } from "../../workspace/repos.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerExtractInfra(program: Command): void {
  program
    .command("extract-infra")
    .description("read the deployment descriptions: containers, their environment and host names, gateway rules")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      const db = ctx.openDb();
      try {
        const files = db.prepare("SELECT repo_id AS repo, path FROM file").all() as Array<{ repo: string; path: string }>;
        const dirs = new Map(config.repos.map((r) => [r.id, () => locateRepo(r, ctx.layout, ctx.loaded.path).dir]));
        const facts = await extractInfra({ config, files, dirOf: (repo) => dirs.get(repo)?.() ?? "" });
        writeInfra(db, facts, hashOf({ inventory: getMeta(db, "inventory.hash"), infra: config.infra, components: config.components }));
        for (const w of facts.warnings) ctx.log(`warning: ${w}`);
        console.log(`${facts.containers.length} containers, ${facts.rules.length} gateway rules`);
        for (const c of facts.containers) console.log(`  ${c.name}\t${c.component ?? "-"}\t${c.format}\t${c.hostnames.join(",")}`);
        for (const r of facts.rules) console.log(`  rule ${r.gateway}: ${r.match} ${r.path}${r.host ? ` host ${r.host}` : ""} → ${r.target} (priority ${r.priority})`);
      } finally {
        db.close();
      }
    });
}
