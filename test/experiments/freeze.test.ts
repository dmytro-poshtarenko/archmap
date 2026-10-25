import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedConfig } from "../../src/config/load.js";
import { dataLayout, toolRoot } from "../../src/core/paths.js";
import { freeze, freezeProblems } from "../../src/experiments/freeze.js";
import { checkFrozen } from "../../src/experiments/guards.js";
import { saveLabel } from "../../src/labelling/labels.js";
import { TEMPLATES } from "../../src/llm/prompts.js";
import { openCandidates, openLabels } from "../../src/labelling/store.js";
import { openDb } from "../../src/store/db.js";
import { runInventory } from "../../src/workspace/inventory.js";
import { commit, gitRepo, makeConfig, tempDir, writeTree } from "../helpers.js";

/**
 * A rehearsal of the protocol after the freeze on a made-up target: a tool
 * repository, a main and a held-out repository, a labelled test split.
 */
function rehearsal() {
  const root = tempDir();
  const read = (p: string) => readFileSync(join(toolRoot, p), "utf8");
  gitRepo(root, {
    "docs/labelling-guide.md": read("docs/labelling-guide.md"),
    "rules/generic@1.yaml": read("rules/generic@1.yaml"),
    ...Object.fromEntries(Object.values(TEMPLATES).map((ref) => [`prompts/${ref}.md`, read(`prompts/${ref}.md`)])),
    "src/method.ts": "export const method = 1;\n",
    ".gitignore": "data/\n",
  });
  const data = join(root, "data");
  writeTree(data, {
    "main/src/a.ts": "export const a = fetch('/api/a');\n",
    "mobile/src/b.ts": "export const b = fetch('/api/b');\n",
  });
  const config = makeConfig({
    name: "rehearsal",
    repos: [
      { id: "main", path: "main", role: "main", licence: "MIT", publishable: true },
      { id: "mobile", path: "mobile", role: "heldout", licence: "MIT", publishable: true },
    ],
    rules: { packs: ["generic@1"] },
  });
  const loaded = { path: join(data, "config.yaml"), config, lock: undefined, fixedShas: [], hash: "rehearsal-config" } as unknown as LoadedConfig;
  const layout = dataLayout(data);

  // the sample frame: 10 http candidates in the test split, 3 of them sampled and labelled
  const candidates = openCandidates(layout, "rehearsal");
  const insert = candidates.prepare("INSERT INTO candidate(id, repo, path, line, split, component, stratum, patterns, text_sha) VALUES (?, 'main', 'src/a.ts', ?, 'test', NULL, 'http', '[]', 'x')");
  for (let line = 1; line <= 10; line++) insert.run(`main:src/a.ts:${line}`, line);
  for (let rank = 1; rank <= 3; rank++) candidates.prepare("INSERT INTO sample(candidate, pool, rank, double) VALUES (?, 'main', ?, 0)").run(`main:src/a.ts:${rank}`, rank);
  candidates.close();
  const labels = openLabels(layout, "rehearsal", "test", "annotate", false);
  const label = (line: number, target: string, caseNo: number) =>
    saveLabel(labels, { item: `main:src/a.ts:${line}`, repo: "main", path: "src/a.ts", line, endLine: null, origin: "sample", isSite: true, type: "http", target, caseNo, reason: null, note: null }, "A", "1.1");
  label(1, "http:GET:/api/a@api", 1);
  label(2, "http:GET:/api/b@api", 4);
  label(3, "http:GET:/api/c@api", 5);
  labels.close();
  return { root, data, loaded, layout };
}

describe("freezing the method", () => {
  it("lists what stops it, then freezes with the predicted shares and opens the guards", () => {
    const { root, data, loaded, layout } = rehearsal();
    const input = { root, loaded, layout, tag: "freeze-1", annotator: "A" };
    expect(freezeProblems(input)).toEqual([expect.stringMatching(/no dev report/), expect.stringMatching(/hypothesis 3/)]);

    mkdirSync(join(data, "reports", "rehearsal", "dev"), { recursive: true });
    writeFileSync(join(data, "reports", "rehearsal", "dev", "summary.json"), "{}\n");
    mkdirSync(join(data, "out", "rehearsal", "h3"), { recursive: true });
    writeFileSync(join(data, "out", "rehearsal", "h3", "decision.json"), JSON.stringify({ splitFilesFor: { [loaded.config.llm.local.model]: true } }));
    expect(freezeProblems(input)).toEqual([expect.stringMatching(/llm\.chunking\.local is false/)]);
    writeFileSync(join(data, "out", "rehearsal", "h3", "decision.json"), JSON.stringify({ splitFilesFor: { [loaded.config.llm.local.model]: false } }));
    expect(freezeProblems(input)).toEqual([]);

    // before the freeze: the test labels stay closed and the held-out repository stays out
    expect(() => openLabels(layout, "rehearsal", "test", "evaluate", checkFrozen({ root, configHash: loaded.hash }).ok)).toThrow(/after the method is frozen/);
    const before = runInventory(openDb(":memory:"), loaded.config, layout, loaded.path, { allowHeldout: false, configHash: loaded.hash });
    expect(before.skipped).toEqual(["mobile"]);

    const { manifest, digest } = freeze(input);
    for (const share of [manifest.predictedShares.rules, manifest.predictedShares.infra, manifest.predictedShares.llm]) expect(share).toBeCloseTo(1 / 3);
    expect(manifest.predictedShares.units).toBe(3);
    expect(digest).toMatch(/rules 33\.3 %, infrastructure 33\.3 %, language model 33\.3 %/);
    // the guide as every label records it, and how the cloud model is reached
    expect(manifest.guide).toMatch(/^1\.\d+\+[0-9a-f]{8}$/);
    expect(manifest.models.cloudChannel).toBe("api");
    expect(digest).toMatch(/\(cloud, through the API\)/);
    expect(checkFrozen({ root, configHash: loaded.hash }).ok).toBe(true);

    // after: the test labels open as the reference and the held-out repository joins the inventory
    openLabels(layout, "rehearsal", "test", "evaluate", true).close();
    const after = runInventory(openDb(":memory:"), loaded.config, layout, loaded.path, { allowHeldout: checkFrozen({ root, configHash: loaded.hash }).ok, configHash: loaded.hash });
    expect(after.skipped).toEqual([]);
    expect(freezeProblems(input)).toEqual([expect.stringMatching(/frozen already/), expect.stringMatching(/tag freeze-1 exists/)]);

    // any change to the method afterwards closes the guard again
    commit(root, { "src/method.ts": "export const method = 2;\n" }, "tune after the freeze");
    expect(checkFrozen({ root, configHash: loaded.hash })).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since the freeze/) });
  });
});
