import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataLayout } from "../../src/core/paths.js";
import type { Candidate } from "../../src/labelling/candidates.js";
import { allocate, drawGapFiles, drawSample, loadSample, storeSample } from "../../src/labelling/sample.js";
import { openCandidates } from "../../src/labelling/store.js";
import { tempDir } from "../helpers.js";
import { fakeSnapshot } from "./fixtures.js";

function population(sizes: Record<string, number>): Candidate[] {
  const out: Candidate[] = [];
  for (const [stratum, n] of Object.entries(sizes)) {
    for (let i = 0; i < n; i++) {
      out.push({
        id: `main:${stratum}/f${i % 37}.ts:${i + 1}`,
        repo: "main",
        path: `${stratum}/f${i % 37}.ts`,
        line: i + 1,
        split: i % 10 < 3 ? "dev" : "test",
        component: null,
        stratum: stratum as Candidate["stratum"],
        patterns: ["p"],
        textSha: "x",
      });
    }
  }
  return out;
}

const OPTS = { seed: 7, size: 400, minPerStratum: 30, doubleShare: 0.2 };

describe("allocation", () => {
  it("is proportional above the minimum and keeps the total", () => {
    const a = allocate({ broker: 1242, db: 3003, ddp: 115, http: 1372, trigger: 21 }, 400, 30);
    expect(a).toEqual({ broker: 77, db: 187, ddp: 30, http: 85, trigger: 21 });
    expect(Object.values(a).reduce((s, v) => s + v, 0)).toBe(400);
  });

  it("takes everything when the population is smaller than the sample", () => {
    expect(allocate({ a: 10, b: 5 }, 400, 30)).toEqual({ a: 10, b: 5 });
  });

  it("caps a stratum at its size and gives the rest to the others", () => {
    const a = allocate({ big: 1000, small: 40 }, 100, 60);
    expect(a.small).toBe(40);
    expect(a.big).toBe(60);
  });
});

describe("sample", () => {
  const candidates = population({ broker: 500, db: 1200, ddp: 60, http: 600, trigger: 12 });

  it("is the same for the same seed and differs for another", () => {
    const a = drawSample("main", candidates, OPTS);
    expect(drawSample("main", [...candidates].reverse(), OPTS)).toEqual(a);
    expect(drawSample("main", candidates, { ...OPTS, seed: 8 }).items).not.toEqual(a.items);
    expect(a.items).toHaveLength(400);
    expect(new Set(a.items.map((i) => i.candidate)).size).toBe(400);
  });

  it("respects the allocation and the second annotator's share per stratum", () => {
    const s = drawSample("main", candidates, OPTS);
    for (const [stratum, { sample }] of Object.entries(s.allocation)) {
      const items = s.items.filter((i) => i.stratum === stratum);
      expect(items).toHaveLength(sample);
      expect(items.filter((i) => i.double)).toHaveLength(Math.ceil(sample * 0.2));
    }
    expect(s.allocation.trigger).toEqual({ population: 12, sample: 12 });
  });

  it("orders each split so that the strata take turns", () => {
    const s = drawSample("main", candidates, OPTS);
    const split = new Map(candidates.map((c) => [c.id, c.split]));
    const dev = s.items.filter((i) => split.get(i.candidate) === "dev");
    const firstRound = new Set(dev.slice(0, 5).map((i) => i.stratum));
    expect(firstRound.size).toBe(5);
    const testStart = s.items.findIndex((i) => split.get(i.candidate) === "test");
    expect(s.items.slice(0, testStart).every((i) => split.get(i.candidate) === "dev")).toBe(true);
    expect(s.items.map((i) => i.rank)).toEqual(s.items.map((_, i) => i + 1));
  });

  it("is stored once and replaced only on request", () => {
    const db = openCandidates(dataLayout(join(tempDir(), "data")), "t");
    const insert = db.prepare(
      "INSERT INTO candidate(id, repo, path, line, split, component, stratum, patterns, text_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of candidates) insert.run(c.id, c.repo, c.path, c.line, c.split, c.component, c.stratum, "[]", c.textSha);
    const s = drawSample("main", candidates, OPTS);
    expect(storeSample(db, s, { force: false, params: OPTS })).toBe("stored");
    expect(storeSample(db, s, { force: false, params: OPTS })).toBe("unchanged");
    const other = drawSample("main", candidates, { ...OPTS, seed: 9 });
    expect(() => storeSample(db, other, { force: false, params: OPTS })).toThrow(/--force/);
    expect(storeSample(db, other, { force: true, params: OPTS })).toBe("stored");
    expect(loadSample(db, "main").map((i) => i.candidate)).toEqual(other.items.map((i) => i.candidate));
  });
});

describe("gap-check files", () => {
  it("are drawn among files using a client, the same way every time", () => {
    const files: Record<string, { text: string; split?: "dev" | "test" }> = {};
    for (let i = 0; i < 40; i++) files[`main:src/f${i}.ts`] = { text: i % 2 === 0 ? "import x from 'axios';\n" : "export {};\n", split: i % 3 === 0 ? "dev" : "test" };
    files["main:src/heldout.ts"] = { text: "import x from 'axios';\n" };
    const snapshot = fakeSnapshot(files);
    const a = drawGapFiles(snapshot, [/from\s+'axios'/], 5, 7, ["dev", "test"]);
    expect(a).toHaveLength(5);
    expect(a.every((f) => Number(/f(\d+)/.exec(f.path)?.[1] ?? 1) % 2 === 0 || f.path === "src/heldout.ts")).toBe(true);
    expect(drawGapFiles(snapshot, [/from\s+'axios'/], 5, 7, ["dev", "test"])).toEqual(a);
    expect(drawGapFiles(snapshot, [/from\s+'axios'/], 5, 8, ["dev", "test"])).not.toEqual(a);
  });
});
