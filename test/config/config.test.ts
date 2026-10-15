import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, lockPathFor, parseConfig } from "../../src/config/load.js";
import { toolRoot } from "../../src/core/paths.js";
import { makeConfig, tempDir } from "../helpers.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const YAML = `
name: demo
repos:
  - { id: main, url: github.com/example/main, role: main }
experiment:
  seeds: { split: 1, sample: 2, bootstrap: 3 }
  devShare: 0.3
  sample: { main: 10, minPerType: 1, heldout: 5 }
  secondAnnotator: 0.2
`;

describe("config", () => {
  it("fills defaults, including nested sections left out", () => {
    const c = makeConfig();
    expect(c.codeUnits.splitDirs).toEqual([]);
    expect(c.rules.liftDepth).toBe(3);
    expect(c.infra.compose).toEqual([]);
    expect(c.interactionTypes).toEqual(["http", "ddp", "broker", "db", "trigger"]);
    expect(c.repos[0]?.licence).toBe("MIT");
  });

  it("rejects unknown keys, bad globs and ambiguous repos", () => {
    expect(() => makeConfig({ extra: 1 })).toThrow(ConfigError);
    expect(() => makeConfig({ components: [{ id: "a", kind: "service", include: ["no-repo-prefix"] }] })).toThrow(
      ConfigError,
    );
    expect(() => makeConfig({ repos: [{ id: "x", url: "u", path: "p", role: "main" }] })).toThrow(/exactly one/);
    expect(() =>
      makeConfig({
        repos: [
          { id: "x", path: "a", role: "main" },
          { id: "x", path: "b", role: "desktop" },
        ],
      }),
    ).toThrow(/duplicate repo id/);
  });

  it("merges the lock file and hashes the effective config", () => {
    const dir = tempDir();
    const file = join(dir, "demo.yaml");
    writeFileSync(file, YAML);
    const unpinned = loadConfig(file);
    expect(unpinned.config.repos[0]?.sha).toBeUndefined();

    writeFileSync(lockPathFor(file), JSON.stringify({ pinnedAt: "t", repos: { main: SHA_A } }));
    const pinned = loadConfig(file);
    expect(pinned.config.repos[0]?.sha).toBe(SHA_A);
    expect(pinned.fixedShas).toEqual([]);
    expect(pinned.hash).not.toBe(unpinned.hash);
    expect(loadConfig(file).hash).toBe(pinned.hash);

    writeFileSync(file, YAML.replace("role: main }", `role: main, sha: ${SHA_B} }`));
    expect(() => loadConfig(file)).toThrow(/differs/);
  });

  it("parses the Rocket.Chat config shipped with the tool", () => {
    const loaded = loadConfig(join(toolRoot, "configs", "rocketchat.yaml"));
    expect(loaded.config.repos.map((r) => r.role)).toContain("heldout");
    expect(parseConfig(loaded.config)).toEqual(loaded.config);
  });
});
