import type { Command } from "commander";
import { serveMcp } from "../../mcp/server.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("serve the archmap MCP tools over stdio: rebuild_map, list_unresolved, create_feature_view")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      await serveMcp({ loaded: ctx.loaded, layout: ctx.layout, openDb: ctx.openDb });
    });
}
