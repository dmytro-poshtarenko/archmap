import type { Command } from "commander";
import type { RelationKind } from "../../map/graph.js";
import { addFeatureView, buildMap, graphOf, mapDir } from "../../map/run.js";
import { createContext, type GlobalOptions } from "../context.js";

const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

export function registerMap(program: Command): void {
  program
    .command("build-map")
    .description("write the LikeC4 model of a run (system map, a view of each part) and validate it")
    .option("--run <id>", "run to draw", "full")
    .action(async (opts: { run: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        const dir = mapDir(ctx.layout.root, ctx.loaded.config.name, opts.run);
        const { graph, diagnostics } = await buildMap(db, ctx.loaded.config, opts.run, dir);
        console.log(`${graph.elements.length} elements, ${graph.relations.length} relations in ${dir}`);
        for (const d of diagnostics) console.log(`  ${d.source ?? ""}:${d.line ?? ""} ${d.message}`);
        console.log(diagnostics.length === 0 ? "LikeC4: no diagnostics" : `LikeC4: ${diagnostics.length} diagnostics`);
        if (diagnostics.length > 0) process.exitCode = 1;
      } finally {
        db.close();
      }
    });

  program
    .command("feature-view <name>")
    .description("add a view of the parts a feature uses: breadth first from seeds along the map's relations")
    .option("--run <id>", "run whose map is extended", "full")
    .requiredOption("--seeds <seeds>", "comma-separated: element ids, route patterns (/api/v1/rooms.*), ns:<broker service>, coll:<collection>, keywords")
    .option("--depth <n>", "relation hops, 1 to 4", (v) => Number.parseInt(v, 10), 1)
    .option("--kinds <kinds>", "comma-separated relation kinds: http, ddp, rpc, event, db, trigger")
    .option("--direction <dir>", "in, out or both", "both")
    .action(async (name: string, opts: { run: string; seeds: string; depth: number; kinds?: string; direction: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        const dir = mapDir(ctx.layout.root, ctx.loaded.config.name, opts.run);
        const graph = graphOf(db, ctx.loaded.config, opts.run);
        const { feature, diagnostics } = await addFeatureView(graph, dir, {
          name,
          seeds: list(opts.seeds),
          depth: opts.depth,
          kinds: opts.kinds ? (list(opts.kinds) as RelationKind[]) : undefined,
          direction: opts.direction as "in" | "out" | "both",
        });
        console.log(`view feature_${feature.slug}: ${feature.elements.join(", ")}`);
        if (feature.unmatched.length > 0) console.log(`seeds matching nothing: ${feature.unmatched.join(", ")}`);
        console.log(diagnostics.length === 0 ? "LikeC4: no diagnostics" : `LikeC4: ${diagnostics.length} diagnostics`);
        for (const d of diagnostics) console.log(`  ${d.source ?? ""}:${d.line ?? ""} ${d.message}`);
      } finally {
        db.close();
      }
    });
}
