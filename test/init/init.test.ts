import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../../src/cli/context.js";
import { doctorChecks } from "../../src/cli/commands/doctor.js";
import { claudeCommands, mcpServers, shellWord } from "../../src/cli/commands/setup.js";
import { loadConfig, parseConfig } from "../../src/config/load.js";
import { CONFIG_FILE, resolveConfigPath, resolveDataDir, toolRoot } from "../../src/core/paths.js";
import { detect, idOf, kindOfPackage } from "../../src/init/detect.js";
import { renderConfig } from "../../src/init/write.js";
import { runMapPipeline } from "../../src/pipeline/map.js";
import { tempDir, writeTree } from "../helpers.js";

const NO_MODELS = { ollama: null, claudeCode: false, apiKey: false };

/** mini-complex copied as a user's project would sit on disk: web, api and worker, and a compose file. */
function shop(): string {
  const dir = join(tempDir(), "shop");
  cpSync(join(toolRoot, "fixtures", "mini-complex"), dir, { recursive: true });
  return dir;
}

const env = { config: process.env.ARCHMAP_CONFIG, data: process.env.ARCHMAP_DATA };
afterEach(() => {
  for (const [key, value] of [["ARCHMAP_CONFIG", env.config], ["ARCHMAP_DATA", env.data]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("archmap init", () => {
  it("finds the parts of mini-complex as the hand-written config names them", () => {
    const d = detect(shop());
    expect(d.repos).toEqual([{ id: "shop", path: "." }]);
    expect(d.components.map((c) => [c.id, c.kind, c.include])).toEqual([
      ["web", "client", ["shop:web/**"]],
      ["api", "service", ["shop:api/**"]],
      ["worker", "service", ["shop:worker/**"]],
      ["traefik", "gateway", []],
      // BullMQ keeps its jobs in Redis, so the Redis container is a bus
      ["redis", "bus", []],
    ]);
    expect(d.infra.compose).toEqual(["shop:infra/docker-compose.yml"]);
    expect(d.packs).toEqual(["generic@1"]);
  });

  it("writes a config that loads, then `archmap map` builds the map with no further step", async () => {
    const dir = shop();
    const text = renderConfig(detect(dir), { use: "none" }, NO_MODELS, "2026-10-26");
    writeFileSync(join(dir, CONFIG_FILE), text);
    expect(loadConfig(join(dir, CONFIG_FILE)).config.llm.use).toBe("none");
    const ctx = createContext({ config: join(dir, CONFIG_FILE) });
    // the data folder sits next to the config and keeps itself out of git
    expect(ctx.layout.root).toBe(join(dir, ".archmap"));
    expect(readFileSync(join(dir, ".archmap", ".gitignore"), "utf8")).toContain("*");
    const result = await runMapPipeline(ctx, "none", () => {});
    expect(result).toMatchObject({ run: "full", elements: 8, relations: 11, diagnostics: [] });
    expect(result.steps.map((s) => s.step)).toEqual(["inventory", "extract", "extract-infra", "classify", "match", "build-map"]);
    expect(existsSync(join(dir, ".archmap", "out", "shop", "current", "c4-model.c4"))).toBe(true);
  }, 60_000);

  it("in a monorepo, takes the apps and leaves out libraries, tests and the workspace root", () => {
    const dir = join(tempDir(), "store");
    writeTree(dir, {
      "package.json": JSON.stringify({ name: "store", private: true, workspaces: ["apps/*", "packages/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "@store/web", dependencies: { react: "19" }, scripts: { start: "vite preview" } }),
      "apps/api/package.json": JSON.stringify({ name: "@store/api", dependencies: { "@nestjs/core": "11" } }),
      "apps/api/Dockerfile": "FROM node:24",
      "packages/ui/package.json": JSON.stringify({ name: "@store/ui", dependencies: { react: "19" } }),
      "test/e2e/package.json": JSON.stringify({ name: "e2e", dependencies: { express: "5" }, scripts: { start: "node ." } }),
      "docker-compose.yml": "services:\n  api:\n    build: ./apps/api\n  db:\n    image: postgres:17\n  proxy:\n    image: nginx:1.27\n",
    });
    const d = detect(dir);
    expect(d.components.map((c) => [c.id, c.kind, c.include])).toEqual([
      ["web", "client", ["store:apps/web/**"]],
      ["api", "service", ["store:apps/api/**"]],
      ["proxy", "gateway", []],
      ["db", "database", []],
    ]);
    const api = d.components.find((c) => c.id === "api");
    expect(api?.why).toBe("docker-compose service api, by its build context; @nestjs/core in package.json");
  });

  it("reads each git repository of a folder, and nests parts without owning each other's code", () => {
    const dir = join(tempDir(), "platform");
    writeTree(dir, {
      "frontend/.git/HEAD": "ref: refs/heads/main\n",
      "frontend/package.json": JSON.stringify({ name: "frontend", dependencies: { vue: "3" } }),
      "backend/.git/HEAD": "ref: refs/heads/main\n",
      "backend/package.json": JSON.stringify({ name: "backend", dependencies: { express: "5" }, scripts: { start: "node ." } }),
      "backend/admin/package.json": JSON.stringify({ name: "admin", dependencies: { react: "19" }, scripts: { start: "vite" } }),
    });
    const d = detect(dir);
    expect(d.repos).toEqual([
      { id: "backend", path: "./backend" },
      { id: "frontend", path: "./frontend" },
    ]);
    const backend = d.components.find((c) => c.id === "backend");
    expect(backend).toMatchObject({ kind: "service", include: ["backend:**"], exclude: ["backend:admin/**"] });
    expect(d.components.find((c) => c.id === "frontend")).toMatchObject({ kind: "client", include: ["frontend:**"] });
  });

  it("tells a client from a server-side part by what its package.json depends on", () => {
    const k = (deps: string[], name = "x") => kindOfPackage({ deps: new Set(deps), name, dir: name, meteor: false }).kind;
    expect([k(["react"]), k(["next", "react"]), k(["react-native"]), k(["electron", "express"])]).toEqual(["client", "client", "client", "client"]);
    expect([k(["express", "react"]), k(["@nestjs/core"]), k(["bullmq"]), k([], "billing")]).toEqual(["service", "service", "service", "service"]);
    expect(k([], "frontend")).toBe("client");
    expect([idOf("@acme/Web App"), idOf("___"), idOf("2024")]).toEqual(["web-app", "project", "2024"]);
  });

  it("quotes what YAML would read as a number or a boolean", () => {
    const d = { name: "2024", repos: [{ id: "2024", path: "." }], components: [{ id: "true", kind: "service" as const, include: ["2024:**"], exclude: [], aliases: [], why: "test" }], infra: { compose: [], k8s: [], nginx: [], terraform: [], helm: [] }, packs: ["generic@1"] };
    const config = parseConfig(parseYaml(renderConfig(d, { use: "none" }, NO_MODELS, "2026-10-26")));
    expect([config.name, config.repos[0]?.id, config.components[0]?.id]).toEqual(["2024", "2024", "true"]);
  });
});

describe("where a command finds its config and data", () => {
  it("looks for archmap.yaml here and above, then falls back to the tool's own config inside the tool", () => {
    delete process.env.ARCHMAP_CONFIG;
    const dir = tempDir();
    writeTree(dir, { [CONFIG_FILE]: "name: x\n", "src/deep/file.ts": "" });
    expect(resolveConfigPath(undefined, join(dir, "src", "deep"))).toBe(join(dir, CONFIG_FILE));
    expect(resolveConfigPath("other.yaml", dir)).toMatch(/other\.yaml$/);
    process.env.ARCHMAP_CONFIG = "/from/env.yaml";
    expect(resolveConfigPath(undefined, dir)).toBe("/from/env.yaml");
    delete process.env.ARCHMAP_CONFIG;
    expect(resolveConfigPath(undefined, toolRoot)).toBe(join(toolRoot, "configs", "rocketchat.yaml"));
    const empty = tempDir();
    mkdirSync(join(empty, "x"));
    expect(() => resolveConfigPath(undefined, join(empty, "x"))).toThrow("archmap init");
  });

  it("keeps a project's data next to its config and the tool's own data where the measurements are", () => {
    delete process.env.ARCHMAP_DATA;
    expect(resolveDataDir(undefined, "/work/shop/archmap.yaml")).toBe("/work/shop/.archmap");
    expect(resolveDataDir(undefined, join(toolRoot, "configs", "rocketchat.yaml"))).toBe(join(toolRoot, "..", "data"));
    expect(resolveDataDir("/explicit", "/work/shop/archmap.yaml")).toBe("/explicit");
    process.env.ARCHMAP_DATA = "/env/data";
    expect(resolveDataDir(undefined, "/work/shop/archmap.yaml")).toBe("/env/data");
  });
});

describe("archmap setup claude and archmap doctor", () => {
  it("registers both servers with the config and data in full, so they start from any folder", () => {
    const servers = mcpServers({ command: "/usr/bin/node", args: ["/opt/archmap/dist/cli/index.js"] }, "/work/shop/archmap.yaml", "/work/shop/.archmap");
    expect(claudeCommands(servers, "local")).toEqual([
      ["claude", "mcp", "add", "--scope", "local", "archmap", "--", "/usr/bin/node", "/opt/archmap/dist/cli/index.js", "--config", "/work/shop/archmap.yaml", "--data", "/work/shop/.archmap", "mcp"],
      ["claude", "mcp", "add", "--scope", "local", "archmap-likec4", "--", "/usr/bin/node", "/opt/archmap/dist/cli/index.js", "--config", "/work/shop/archmap.yaml", "--data", "/work/shop/.archmap", "likec4-mcp"],
    ]);
    expect([shellWord("/a/b.js"), shellWord("/my docs/x"), shellWord("it's")]).toEqual(["/a/b.js", "'/my docs/x'", "'it'\\''s'"]);
  });

  it("checks the tools, the config, its repositories and the model, and says what to fix", async () => {
    delete process.env.ARCHMAP_DATA;
    const dir = shop();
    writeFileSync(join(dir, CONFIG_FILE), renderConfig(detect(dir), { use: "none" }, NO_MODELS, "2026-10-26"));
    const ok = await doctorChecks({ config: join(dir, CONFIG_FILE) });
    expect(ok.every((c) => c.ok)).toBe(true);
    expect(ok.map((c) => c.what)).toEqual(expect.arrayContaining([expect.stringMatching(/^LikeC4 /), expect.stringMatching(/^repository shop at /)]));
    // a repository moved away, and a model that is not set up
    writeFileSync(join(dir, CONFIG_FILE), readFileSync(join(dir, CONFIG_FILE), "utf8").replace('path: "."', 'path: "./gone"').replace("use: none", "use: cloud"));
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const bad = (await doctorChecks({ config: join(dir, CONFIG_FILE) })).filter((c) => !c.ok);
      expect(bad.map((c) => c.fix)).toEqual([expect.stringContaining("fix its path"), expect.stringContaining("set ANTHROPIC_API_KEY")]);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
