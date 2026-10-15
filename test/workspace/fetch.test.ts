import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetConfig } from "../../src/config/schema.js";
import { dataLayout } from "../../src/core/paths.js";
import { CheckoutError, fetchRepos } from "../../src/workspace/fetch.js";
import { git, headCommit } from "../../src/workspace/git.js";
import { pinRepos } from "../../src/workspace/pin.js";
import { HeldoutLockedError, locateRepo } from "../../src/workspace/repos.js";
import { commit, gitRepo, makeConfig, tempDir } from "../helpers.js";

function sourceRepo(dir: string, files: Record<string, string>): string {
  const sha = gitRepo(dir, files);
  git(["config", "uploadpack.allowAnySHA1InWant", "true"], dir);
  return sha;
}

function setup() {
  const root = tempDir();
  const mainSha = sourceRepo(join(root, "src-main"), { "index.ts": "export const a = 1;\n" });
  sourceRepo(join(root, "src-mobile"), { "app.ts": "export const m = 1;\n" });
  const config = makeConfig({
    repos: [
      { id: "main", url: `file://${join(root, "src-main")}`, role: "main" },
      { id: "mobile", url: `file://${join(root, "src-mobile")}`, role: "heldout" },
    ],
  });
  return { root, config, mainSha, layout: dataLayout(join(root, "data")), configPath: join(root, "c.yaml") };
}

function pinned(config: TargetConfig): TargetConfig {
  const { lock } = pinRepos(config, undefined);
  return { ...config, repos: config.repos.map((r) => ({ ...r, sha: lock.repos[r.id] })) };
}

describe("pin", () => {
  it("resolves the default branch of every remote, the held-out one included", () => {
    const env = setup();
    const result = pinRepos(env.config, undefined, { now: () => new Date(0) });
    expect(result.lock.repos.main).toBe(env.mainSha);
    expect(result.lock.repos.mobile).toMatch(/^[0-9a-f]{40}$/);
    expect(result.lock.pinnedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("keeps existing pins unless refreshing, and never touches fixed ones", () => {
    const env = setup();
    const old = { pinnedAt: "t", repos: { main: "0".repeat(40), mobile: "1".repeat(40) } };
    expect(pinRepos(env.config, old).lock.repos).toEqual(old.repos);
    const refreshed = pinRepos(env.config, old, { refresh: true, fixed: ["mobile"] });
    expect(refreshed.lock.repos).toEqual({ main: env.mainSha, mobile: "1".repeat(40) });
  });
});

describe("fetch", () => {
  it("checks out the pinned commit and skips the held-out repository", () => {
    const env = setup();
    const config = pinned(env.config);
    const results = fetchRepos(config, env.layout, env.configPath, { allowHeldout: false });
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["main", "fetched"],
      ["mobile", "held-out"],
    ]);
    const main = locateRepo(config.repos[0] as TargetConfig["repos"][number], env.layout, env.configPath);
    expect(headCommit(main.dir)).toBe(env.mainSha);
    const mobile = locateRepo(config.repos[1] as TargetConfig["repos"][number], env.layout, env.configPath);
    expect(existsSync(mobile.dir)).toBe(false);

    expect(fetchRepos(config, env.layout, env.configPath, { allowHeldout: false })[0]?.status).toBe("present");
  });

  it("refuses the held-out repository when asked for it before the freeze", () => {
    const env = setup();
    const config = pinned(env.config);
    expect(() => fetchRepos(config, env.layout, env.configPath, { ids: ["mobile"], allowHeldout: false })).toThrow(
      HeldoutLockedError,
    );
    expect(fetchRepos(config, env.layout, env.configPath, { ids: ["mobile"], allowHeldout: true })[0]?.status).toBe(
      "fetched",
    );
  });

  it("fetches a pinned commit that is no longer the branch tip", () => {
    const env = setup();
    const config = pinned(env.config);
    commit(join(env.root, "src-main"), { "index.ts": "export const a = 2;\n" }, "later");
    const [main] = fetchRepos(config, env.layout, env.configPath, { ids: ["main"], allowHeldout: false });
    expect(headCommit(main?.dir ?? "")).toBe(env.mainSha);
  });

  it("rejects a checkout that was modified locally", () => {
    const env = setup();
    const config = pinned(env.config);
    const [main] = fetchRepos(config, env.layout, env.configPath, { ids: ["main"], allowHeldout: false });
    writeFileSync(join(main?.dir ?? "", "index.ts"), "changed\n");
    expect(() => fetchRepos(config, env.layout, env.configPath, { ids: ["main"], allowHeldout: false })).toThrow(
      CheckoutError,
    );
  });
});
