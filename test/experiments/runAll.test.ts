import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { dataLayout, toolRoot } from "../../src/core/paths.js";
import { plannedRuns, runAll } from "../../src/experiments/runAll.js";
import { loadLinks } from "../../src/match/run.js";
import { openDb } from "../../src/store/db.js";
import { runInventory } from "../../src/workspace/inventory.js";
import { tempDir } from "../helpers.js";

describe("run-all", () => {
  it("reproduces every step of a measurement on mini-complex from recorded answers only", async () => {
    const loaded = loadConfig(join(toolRoot, "configs", "mini.yaml"));
    const layout = dataLayout(tempDir());
    mkdirSync(layout.db, { recursive: true });
    const db = openDb(join(layout.db, "mini.sqlite"));
    runInventory(db, loaded.config, layout, loaded.path, { allowHeldout: false, configHash: loaded.hash });
    const logs: string[] = [];
    const auditFile = join(layout.root, "audit.jsonl");
    const steps = await runAll(db, loaded, layout, { model: "replay-local", sites: "sample", split: "dev", analysis: true, frozen: false, log: (m) => logs.push(m), auditFile });
    expect(steps.map((s) => s.step)).toEqual([
      "extract",
      "extract-infra",
      "llm-routes",
      "classify",
      "match full",
      "match no-llm",
      "match no-infra",
      "match no-rules",
      "resolve full select",
      "resolve no-infra select",
      "resolve no-rules free",
      "resolve full select-all",
      "resolve full free-all",
      "evaluate dev",
      "analysis",
    ]);
    expect(steps.reduce((s, x) => s + x.costUsd, 0)).toBe(0);
    const runs = plannedRuns("local");
    expect(loadLinks(db, runs.full)).toHaveLength(8);
    expect(loadLinks(db, "no-rules").every((l) => l.reason === "rules-off")).toBe(true);
    const record = JSON.parse(readFileSync(join(layout.root, "out", "mini", "run-all-dev.json"), "utf8"));
    expect(record.runs.full).toBe("full.select.local");
    expect(existsSync(join(layout.root, "out", "mini", "no-llm", "eval", "dev", "site_results.csv"))).toBe(true);
    expect(steps.at(-1)?.note).toMatch(/no labelled units/);
    expect(readFileSync(auditFile, "utf8").trim().split("\n")).toHaveLength(runs.all.length);
  }, 120_000);

  it("runs only the method itself for the held-out repository", async () => {
    const loaded = loadConfig(join(toolRoot, "configs", "mini.yaml"));
    const layout = dataLayout(tempDir());
    mkdirSync(layout.db, { recursive: true });
    const db = openDb(join(layout.db, "mini.sqlite"));
    runInventory(db, loaded.config, layout, loaded.path, { allowHeldout: false, configHash: loaded.hash });
    const auditFile = join(layout.root, "audit.jsonl");
    const steps = await runAll(db, loaded, layout, { model: "replay-local", sites: "sample", split: "dev", analysis: true, methodOnly: true, frozen: false, log: () => {}, auditFile });
    expect(steps.filter((s) => s.step.startsWith("resolve")).map((s) => s.step)).toEqual(["resolve full select"]);
    // the method and the variant without the model, which asks nothing
    expect(readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).run)).toEqual(["full.select.local", "no-llm"]);
  }, 120_000);
});
