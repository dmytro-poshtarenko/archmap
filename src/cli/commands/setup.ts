import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { createContext, type GlobalOptions } from "../context.js";

export interface McpServer {
  name: string;
  command: string;
  args: string[];
}

/** How this archmap starts: node, its loader options (tsx when run from the sources) and the CLI's entry. */
export function selfCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [...process.execArgv, process.argv[1] as string] };
}

/**
 * The two MCP servers of a project: archmap's own tools, and LikeC4's
 * read-only server on its map. Both name the config and the data folder in
 * full, so they start the same from any folder an agent runs in.
 */
export function mcpServers(self: { command: string; args: string[] }, configPath: string, dataDir: string, name = "archmap"): McpServer[] {
  const project = ["--config", configPath, "--data", dataDir];
  return [
    { name, command: self.command, args: [...self.args, ...project, "mcp"] },
    { name: `${name}-likec4`, command: self.command, args: [...self.args, ...project, "likec4-mcp"] },
  ];
}

/** A word as a POSIX shell reads it. */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** The commands that register the servers in Claude Code. */
export function claudeCommands(servers: McpServer[], scope: string): string[][] {
  return servers.map((s) => ["claude", "mcp", "add", "--scope", scope, s.name, "--", s.command, ...s.args]);
}

export function registerSetup(program: Command): void {
  const setup = program.command("setup").description("connect archmap to a coding agent");
  setup
    .command("claude")
    .description("register archmap's MCP server and LikeC4's in Claude Code, for this project's config")
    .option("--scope <scope>", "local (this folder, for you), project (.mcp.json here) or user (every folder)", "local")
    .option("--name <name>", "name of the archmap server; LikeC4's gets '-likec4' after it", "archmap")
    .option("--print", "print the commands and the .mcp.json entry instead of running them")
    .action((opts: { scope: string; name: string; print?: boolean }, cmd: Command) => {
      if (!["local", "project", "user"].includes(opts.scope)) throw new Error(`unknown scope '${opts.scope}': local, project or user`);
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const servers = mcpServers(selfCommand(), ctx.loaded.path, ctx.layout.root, opts.name);
      const commands = claudeCommands(servers, opts.scope);
      const entry = { mcpServers: Object.fromEntries(servers.map((s) => [s.name, { command: s.command, args: s.args }])) };
      const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
      if (opts.print || claude.status !== 0) {
        if (!opts.print) console.log("Claude Code (the `claude` command) is not installed here. To connect it later, run:");
        for (const c of commands) console.log(c.map(shellWord).join(" "));
        console.log("\nFor another MCP client, or a .mcp.json of your own:");
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      for (const [i, s] of servers.entries()) {
        // a server registered before, for another config or version, is replaced
        spawnSync("claude", ["mcp", "remove", "--scope", opts.scope, s.name], { encoding: "utf8" });
        const add = spawnSync(commands[i]?.[0] as string, commands[i]?.slice(1) ?? [], { encoding: "utf8" });
        if (add.status !== 0) throw new Error(`claude mcp add ${s.name} failed: ${(add.stderr || add.stdout).trim()}`);
        console.log(`registered ${s.name} (${opts.scope} scope)`);
      }
      console.log(`Claude Code now has the tools of ${ctx.loaded.config.name}: start it${opts.scope === "user" ? "" : ` in ${process.cwd()}`} and ask, e.g., «Which parts take part in checkout? Make a feature view.»`);
    });
}
