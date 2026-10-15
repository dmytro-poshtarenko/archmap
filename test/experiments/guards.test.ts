import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFrozen } from "../../src/experiments/guards.js";
import { git } from "../../src/workspace/git.js";
import { commit, gitRepo, tempDir, writeTree } from "../helpers.js";

function frozenRepo() {
  const root = tempDir();
  const method = gitRepo(root, { "src/method.ts": "export const v = 1;\n" });
  const manifest = { tag: "freeze-1", commit: method, configHash: "cfg", createdAt: "2026-10-15T00:00:00Z" };
  commit(root, { "freeze/manifest.json": JSON.stringify(manifest) }, "freeze");
  git(["tag", "-a", "freeze-1", "-m", "freeze"], root);
  return root;
}

describe("freeze guard", () => {
  it("is closed without a manifest", () => {
    const root = tempDir();
    gitRepo(root, { "a.ts": "1" });
    expect(checkFrozen({ root, configHash: "cfg" })).toMatchObject({ ok: false, reason: expect.stringMatching(/not frozen/) });
  });

  it("opens on the frozen method with the frozen config", () => {
    const root = frozenRepo();
    expect(checkFrozen({ root, configHash: "cfg" }).ok).toBe(true);
    expect(checkFrozen({ root, configHash: "other" })).toMatchObject({ ok: false, reason: expect.stringMatching(/config/) });
  });

  it("tolerates the evaluation log, committed or not", () => {
    const root = frozenRepo();
    writeTree(root, { "audit/evaluations.jsonl": "{}\n" });
    expect(checkFrozen({ root, configHash: "cfg" }).ok).toBe(true);
    commit(root, {}, "log evaluation");
    expect(checkFrozen({ root, configHash: "cfg" }).ok).toBe(true);
  });

  it("closes when the method changes after the freeze", () => {
    const root = frozenRepo();
    writeFileSync(join(root, "src/method.ts"), "export const v = 2;\n");
    expect(checkFrozen({ root, configHash: "cfg" })).toMatchObject({ ok: false, reason: expect.stringMatching(/uncommitted/) });
    commit(root, {}, "tweak");
    expect(checkFrozen({ root, configHash: "cfg" })).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since/) });
  });

  it("closes without the tag", () => {
    const root = frozenRepo();
    git(["tag", "-d", "freeze-1"], root);
    expect(checkFrozen({ root, configHash: "cfg" }).ok).toBe(false);
  });
});
