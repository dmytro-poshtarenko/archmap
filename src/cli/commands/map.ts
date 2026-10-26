import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { reader } from "../../llm/run.js";
import { MODEL_USES, type ModelUse } from "../../config/schema.js";
import { featureRelations } from "../../map/feature.js";
import type { RelationKind } from "../../map/graph.js";
import { runLikec4 } from "../../map/likec4.js";
import { addFeatureView, buildMap, currentMapDir, currentMapRun, defaultMapRun, graphOf, MODEL_FILE, mapDir, removeFeatureView } from "../../map/run.js";
import { runMapPipeline } from "../../pipeline/map.js";
import { createContext, type GlobalOptions } from "../context.js";

const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

export function registerMap(program: Command): void {
  program
    .command("map")
    .description("the whole method in one command, from the code to a validated map: the steps from inventory to build-map, the model's only if one is set")
    .option("--model <model>", "none, local (Ollama), cloud-cli (Claude Code) or cloud (API key); default: llm.use in the config, else none")
    .option("--open", "start the viewer when the map is built")
    .option("--port <n>", "port of the viewer", "5173")
    .action(async (opts: { model?: string; open?: boolean; port: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const model = (opts.model ?? ctx.loaded.config.llm.use ?? "none") as ModelUse;
      if (!MODEL_USES.includes(model)) throw new Error(`unknown model '${model}': ${MODEL_USES.join(", ")}`);
      ctx.log(`${ctx.loaded.config.name}: config ${ctx.loaded.path}, data ${ctx.layout.root}, model ${model}`);
      const result = await runMapPipeline(ctx, model, ctx.log);
      console.log(`map of ${ctx.loaded.config.name}: ${result.elements} elements, ${result.relations} relations (run ${result.run})`);
      for (const d of result.diagnostics) console.log(`  ${d.source ?? ""}:${d.line ?? ""} ${d.message}`);
      if (result.diagnostics.length > 0) {
        process.exitCode = 1;
        return;
      }
      if (!opts.open) {
        console.log("open it with `archmap view`");
        return;
      }
      console.log(`LikeC4 viewer on http://localhost:${opts.port}`);
      process.exitCode = await runLikec4(["start", currentMapDir(ctx.layout.root, ctx.loaded.config.name), "--port", opts.port]);
    });

  program
    .command("build-map")
    .description("write the LikeC4 model of a run (system map, a view of each part) and validate it")
    .option("--run <id>", "run to draw (default: the full method with the model's answers, else full)")
    .action(async (opts: { run?: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        const run = opts.run ?? defaultMapRun(db);
        const dir = mapDir(ctx.layout.root, ctx.loaded.config.name, run);
        const { graph, diagnostics } = await buildMap(db, ctx.loaded.config, run, dir, {
          current: currentMapDir(ctx.layout.root, ctx.loaded.config.name),
          read: reader(ctx.loaded.config, ctx.layout, ctx.loaded.path),
        });
        console.log(`run ${run}: ${graph.elements.length} elements, ${graph.relations.length} relations in ${dir}`);
        for (const d of diagnostics) console.log(`  ${d.source ?? ""}:${d.line ?? ""} ${d.message}`);
        console.log(diagnostics.length === 0 ? "LikeC4: no diagnostics" : `LikeC4: ${diagnostics.length} diagnostics`);
        if (diagnostics.length > 0) process.exitCode = 1;
        else console.log("open it with `archmap view`");
      } finally {
        db.close();
      }
    });

  program
    .command("feature-view <name>")
    .description("add a view of the parts a feature uses: breadth first from seeds along the map's relations")
    .option("--run <id>", "run whose map is extended (default: the map built last)")
    .requiredOption("--seeds <seeds>", "comma-separated: element ids, route patterns (/api/v1/rooms.*), ns:<broker service>, coll:<collection>, keywords")
    .option("--depth <n>", "relation hops, 1 to 4", (v) => Number.parseInt(v, 10), 1)
    .option("--kinds <kinds>", "comma-separated relation kinds: http, ddp, rpc, stream, event, db, route")
    .option("--direction <dir>", "in, out or both", "both")
    .action(async (name: string, opts: { run?: string; seeds: string; depth: number; kinds?: string; direction: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        const run = opts.run ?? currentMapRun(ctx.layout.root, ctx.loaded.config.name) ?? defaultMapRun(db);
        const dir = mapDir(ctx.layout.root, ctx.loaded.config.name, run);
        const graph = graphOf(db, ctx.loaded.config, run);
        const { feature, diagnostics } = await addFeatureView(
          graph,
          dir,
          {
            name,
            seeds: list(opts.seeds),
            depth: opts.depth,
            kinds: opts.kinds ? (list(opts.kinds) as RelationKind[]) : undefined,
            direction: opts.direction as "in" | "out" | "both",
          },
          run,
        );
        console.log(`view feature_${feature.slug} (run ${run}): ${feature.elements.join(", ")}`);
        for (const r of featureRelations(graph, feature)) console.log(`  ${r.source} -[${r.kind}]-> ${r.target}: ${r.title}`);
        if (feature.unmatched.length > 0) console.log(`seeds matching nothing: ${feature.unmatched.join(", ")}`);
        console.log(diagnostics.length === 0 ? "LikeC4: no diagnostics" : `LikeC4: ${diagnostics.length} diagnostics`);
        for (const d of diagnostics) console.log(`  ${d.source ?? ""}:${d.line ?? ""} ${d.message}`);
      } finally {
        db.close();
      }
    });

  program
    .command("remove-view <view>")
    .description("remove a feature view, by its view id (feature_user_presence) or the name it was made with")
    .option("--run <id>", "run whose map holds the view (default: the map built last)")
    .action((view: string, opts: { run?: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { name } = ctx.loaded.config;
      const dir = opts.run ? mapDir(ctx.layout.root, name, opts.run) : currentMapDir(ctx.layout.root, name);
      console.log(`removed ${removeFeatureView(dir, view)}`);
    });

  program
    .command("view")
    .description("open the map in the LikeC4 viewer: a local web server with the system map, a view of each part and the feature views")
    .option("--run <id>", "run whose map to open (default: the map built last)")
    .option("--port <n>", "port of the viewer", "5173")
    .action(async (opts: { run?: string; port: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { name } = ctx.loaded.config;
      const dir = opts.run ? mapDir(ctx.layout.root, name, opts.run) : currentMapDir(ctx.layout.root, name);
      if (!existsSync(join(dir, MODEL_FILE))) throw new Error(`no map in ${dir}; run \`archmap build-map\` first`);
      console.log(`LikeC4 viewer for ${dir} on http://localhost:${opts.port}`);
      process.exitCode = await runLikec4(["start", dir, "--port", opts.port]);
    });
}
