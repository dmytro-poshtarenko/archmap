import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataLayout } from "../../src/core/paths.js";
import { openDb } from "../../src/store/db.js";
import {
  codeUnits,
  componentResolver,
  InventoryError,
  inventoryHash,
  runInventory,
  specificity,
  splitOf,
} from "../../src/workspace/inventory.js";
import { makeConfig, tempDir, writeTree } from "../helpers.js";

const FILES: Record<string, string | Uint8Array> = {
  "main/package.json": "{}",
  "main/README.md": "# demo\n",
  "main/apps/web/package.json": "{}",
  "main/apps/web/src/a.ts": "export const a = 1;\n\nexport const b = 2;\n",
  "main/apps/web/src/b.tsx": "export const B = () => null;\n",
  "main/apps/server/package.json": "{}",
  "main/apps/server/src/api/x.ts": "export const x = 1;\n",
  "main/apps/server/src/client/y.ts": "export const y = 1;\n",
  "main/apps/server/ee/z.ts": "export const z = 1;\n",
  "main/apps/server/src/x.spec.ts": "test\n",
  "main/packages/shared/package.json": "{}",
  "main/packages/shared/index.ts": "export {};\n",
  "main/services/split-me/one/a.ts": "export {};\n",
  "main/services/split-me/two/b.ts": "export {};\n",
  "main/img.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  "main/node_modules/dep/index.js": "module.exports = 1;\n",
  "mobile/app/index.ts": "export {};\n",
};

function setup() {
  const root = tempDir();
  writeTree(root, FILES);
  const config = makeConfig({
    repos: [
      { id: "main", path: "main", role: "main", licence: "MIT", publishable: true },
      { id: "mobile", path: "mobile", role: "heldout", licence: "MIT", publishable: true },
    ],
    licenceZones: [{ repo: "main", globs: ["apps/server/ee/**"], licence: "EE", publishable: false }],
    codeUnits: { splitDirs: ["main:services/split-me/*"] },
    components: [
      { id: "server", kind: "service", include: ["main:apps/server/**"] },
      { id: "server-client", kind: "client", include: ["main:apps/server/src/client/**"] },
      { id: "web", kind: "client", include: ["main:apps/web/**"] },
      { id: "web-twin", kind: "client", include: ["main:apps/web/**"] },
      { id: "mobile", kind: "client", include: ["mobile:**"] },
      { id: "mongo", kind: "database" },
    ],
    exclude: ["**/*.spec.*"],
  });
  return { root, config, configPath: join(root, "config.yaml"), layout: dataLayout(join(root, "data")) };
}

function run(env: ReturnType<typeof setup>, db = openDb(":memory:"), allowHeldout = false) {
  const result = runInventory(db, env.config, env.layout, env.configPath, { allowHeldout, configHash: "h" });
  return { db, result };
}

describe("inventory", () => {
  it("gives the same hash and the same rows on every run", () => {
    const env = setup();
    const first = run(env);
    const second = run(env);
    expect(second.result.hash).toBe(first.result.hash);
    const ids = first.db.prepare("SELECT path, id FROM file ORDER BY path").all();
    const again = run(env, first.db);
    expect(again.result.hash).toBe(first.result.hash);
    expect(first.db.prepare("SELECT path, id FROM file ORDER BY path").all()).toEqual(ids);
  });

  it("assigns units, components, licence zones and languages", () => {
    const env = setup();
    const { db } = run(env);
    const row = (path: string) =>
      db.prepare("SELECT * FROM file WHERE repo_id = 'main' AND path = ?").get(path) as Record<string, unknown> | undefined;

    expect(row("apps/server/src/x.spec.ts")).toBeUndefined();
    expect(row("node_modules/dep/index.js")).toBeUndefined();
    expect(row("apps/server/src/api/x.ts")).toMatchObject({ code_unit: "main:apps/server", component: "server", lang: "ts" });
    expect(row("apps/server/src/client/y.ts")).toMatchObject({ component: "server-client" });
    expect(row("apps/web/src/b.tsx")).toMatchObject({ component: "web", lang: "tsx", code_unit: "main:apps/web" });
    expect(row("packages/shared/index.ts")).toMatchObject({ component: null, code_unit: "main:packages/shared" });
    expect(row("apps/server/ee/z.ts")).toMatchObject({ licence: "EE", publishable: 0 });
    expect(row("apps/server/src/api/x.ts")).toMatchObject({ licence: "MIT", publishable: 1 });
    expect(row("apps/web/src/a.ts")).toMatchObject({ loc: 2 });
    expect(row("img.png")).toMatchObject({ loc: 0, lang: null, bytes: 6 });
    expect(row("services/split-me/two/b.ts")).toMatchObject({ code_unit: "main:services/split-me/two" });

    const units = db.prepare("SELECT root, kind FROM code_unit ORDER BY root").all();
    expect(units).toEqual([
      { root: ".", kind: "package" },
      { root: "apps/server", kind: "package" },
      { root: "apps/web", kind: "package" },
      { root: "packages/shared", kind: "package" },
      { root: "services/split-me/one", kind: "split" },
      { root: "services/split-me/two", kind: "split" },
    ]);
    expect(db.prepare("SELECT id FROM component ORDER BY id").pluck().all()).toContain("mongo");
  });

  it("keeps the held-out repository out until it is allowed", () => {
    const env = setup();
    const locked = run(env);
    expect(locked.result.skipped).toEqual(["mobile"]);
    expect(locked.db.prepare("SELECT count(*) FROM file WHERE repo_id = 'mobile'").pluck().get()).toBe(0);

    const open = run(env, openDb(":memory:"), true);
    expect(open.result.skipped).toEqual([]);
    expect(open.db.prepare("SELECT DISTINCT split FROM file WHERE repo_id = 'mobile'").pluck().all()).toEqual(["heldout"]);
    expect(open.result.hash).not.toBe(locked.result.hash);
  });

  it("follows changes in the snapshot", () => {
    const env = setup();
    const { db, result } = run(env);
    writeFileSync(join(env.root, "main/apps/web/src/a.ts"), "export const a = 3;\n");
    rmSync(join(env.root, "main/packages/shared/index.ts"));
    const changed = run(env, db).result;
    expect(changed.hash).not.toBe(result.hash);
    expect(db.prepare("SELECT count(*) FROM file WHERE path = 'packages/shared/index.ts'").pluck().get()).toBe(0);
    expect(inventoryHash(db)).toBe(changed.hash);
  });

  it("fails when a repository is missing", () => {
    const env = setup();
    rmSync(join(env.root, "main"), { recursive: true });
    expect(() => run(env)).toThrow(InventoryError);
  });
});

describe("split", () => {
  it("is deterministic and close to the configured share", () => {
    const repo = makeConfig().repos[0];
    if (repo === undefined) throw new Error("no repo");
    const paths = Array.from({ length: 5000 }, (_, i) => `src/file-${i}.ts`);
    const splits = paths.map((p) => splitOf(repo, p, 20261015, 0.3));
    expect(paths.map((p) => splitOf(repo, p, 20261015, 0.3))).toEqual(splits);
    const dev = splits.filter((s) => s === "dev").length / paths.length;
    expect(dev).toBeGreaterThan(0.28);
    expect(dev).toBeLessThan(0.32);
    expect(paths.map((p) => splitOf(repo, p, 1, 0.3))).not.toEqual(splits);
  });
});

describe("component resolution", () => {
  it("prefers the most specific glob, then declaration order", () => {
    expect(specificity("apps/server/src/client/**")[0]).toBeGreaterThan(specificity("apps/server/**")[0]);
    const resolve = componentResolver("main", [
      { id: "a", kind: "service", include: ["main:apps/**"], exclude: ["main:apps/skip/**"], aliases: [] },
      { id: "b", kind: "service", include: ["main:apps/b/**"], exclude: [], aliases: [] },
      { id: "c", kind: "service", include: ["main:apps/b/**"], exclude: [], aliases: [] },
      { id: "other", kind: "service", include: ["other:apps/**"], exclude: [], aliases: [] },
    ]);
    expect(resolve("apps/x.ts")).toBe("a");
    expect(resolve("apps/b/x.ts")).toBe("b");
    expect(resolve("apps/skip/x.ts")).toBeNull();
    expect(resolve("lib/x.ts")).toBeNull();
  });

  it("adds the repository root as a unit when it has no package.json", () => {
    expect(codeUnits("r", ["src/a.ts"], [])).toEqual([{ id: "r:.", repoId: "r", root: ".", kind: "repo" }]);
  });
});
