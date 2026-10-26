import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { runLikec4 } from "../../map/likec4.js";
import { currentMapDir, MODEL_FILE, mapDir } from "../../map/run.js";
import { serveMcp } from "../../mcp/server.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("serve the archmap MCP tools over stdio: rebuild_map, list_unresolved, create_feature_view, delete_feature_view")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      await serveMcp({ loaded: ctx.loaded, layout: ctx.layout, openDb: ctx.openDb });
    });

  program
    .command("likec4-mcp")
    .description("serve LikeC4's own read-only MCP server over stdio on the map built last, with the LikeC4 version archmap pins")
    .option("--run <id>", "run whose map to serve (default: the map built last)")
    .action(async (opts: { run?: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { name } = ctx.loaded.config;
      const dir = opts.run ? mapDir(ctx.layout.root, name, opts.run) : currentMapDir(ctx.layout.root, name);
      // stdout carries the protocol: errors go to stderr
      if (!existsSync(join(dir, MODEL_FILE))) throw new Error(`no map in ${dir}; build it with \`archmap build-map\` or the archmap tool rebuild_map`);
      process.exitCode = await runLikec4(["mcp", "--stdio", dir]);
    });
}
