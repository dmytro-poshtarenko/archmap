import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallSite } from "../../src/core/types.js";
import { alignUnits, metricsOf, type SampleFrame } from "../../src/eval/evaluate.js";
import { writeEvaluation } from "../../src/eval/run.js";
import type { Label } from "../../src/labelling/labels.js";
import type { StoredLink } from "../../src/match/run.js";
import { tempDir } from "../helpers.js";

const label = (line: number, fields: Partial<Label>, path = "a.ts"): Label => ({
  item: `r:${path}:${line}`,
  repo: "r",
  path,
  line,
  endLine: null,
  origin: "sample",
  isSite: true,
  type: "http",
  target: null,
  caseNo: null,
  reason: null,
  note: null,
  annotator: "A",
  guide: "1.1",
  updatedAt: "",
  ...fields,
});

const site = (line: number, endLine = line, path = "a.ts"): CallSite => ({
  id: `r:${path}:${line}:1`,
  repo: "r",
  path,
  line,
  endLine,
  col: 1,
  type: "http",
  role: "request",
  detector: "t",
  method: null,
  address: { parts: [], hops: [] },
  components: ["web"],
  liftedFrom: null,
});

const link = (s: CallSite, status: string, target: string | null, alternatives: string[] = []): [string, StoredLink] => [
  s.id,
  { site: s.id, status, target, route: null, component: null, reason: null, via: [], provenance: null, caseNo: null, alternatives },
];

/**
 * Eight sampled lines, hand-computed:
 * C* = {1, 2, 3, 6, 8}, |C*₈| = 1 (line 3), correct = {1, 8}, linked = {1, 2, 4, 5, 8}
 * → R = 2/5, R₁₋₇ = 2/4, P = 2/5, θ = 1/5.
 * Weights: lines 1–4 are http (40 candidates, 4 sampled → 10), lines 5–8 db (8 candidates, 4 sampled → 2)
 * → weighted C* = 34, correct 12, C*₈ 10, linked 34.
 */
function toy() {
  const candidates: SampleFrame["candidates"] = new Map();
  for (let i = 1; i <= 40; i++) candidates.set(`r:a.ts:${i}`, { stratum: "http", split: "dev", component: "web" });
  for (let i = 101; i <= 108; i++) candidates.set(`r:b.ts:${i}`, { stratum: "db", split: "dev", component: "web" });
  const frame: SampleFrame = { candidates, sampled: ["r:a.ts:1", "r:a.ts:2", "r:a.ts:3", "r:a.ts:4", "r:b.ts:105", "r:b.ts:106", "r:b.ts:107", "r:b.ts:108"] };
  const s1 = site(1);
  const s2 = site(2);
  const s4 = site(4);
  const s5 = site(105, 105, "b.ts");
  const s6 = site(106, 106, "b.ts");
  const s8 = site(108, 109, "b.ts");
  const labels = [
    label(1, { target: "http:GET:/api/a@api", caseNo: 1 }),
    label(2, { target: "http:GET:/api/b@api", caseNo: 2 }),
    label(3, { target: "http:GET:/api/d@api", caseNo: 8 }),
    label(4, { target: "NONE", reason: "external" }),
    label(105, { isSite: false, type: null, reason: "declaration" }, "b.ts"),
    label(106, { type: "db", target: "coll:-:g@mongo", caseNo: 5 }, "b.ts"),
    label(107, { isSite: false, type: null, reason: "duplicate" }, "b.ts"),
    label(108, { target: "http:GET:/api/h/:x@api", caseNo: 2 }, "b.ts"),
  ];
  const links = new Map([
    link(s1, "linked", "http:GET:/api/a@api"),
    link(s2, "linked", "http:GET:/api/c@api"),
    link(s4, "linked", "http:GET:/api/e@api"),
    link(s5, "linked", "http:GET:/api/f@api"),
    link(s6, "unresolved", null),
    link(s8, "linked", "http:GET:/api/h/:y@api"),
  ]);
  return { frame, labels, sites: [s1, s2, s4, s5, s6, s8], links };
}

describe("evaluation against the reference", () => {
  it("gives the hand-computed recall, precision and θ on a toy set", () => {
    const t = toy();
    const { units, pending } = alignUnits(t.frame, "dev", t.labels, t.sites, t.links);
    expect(pending).toBe(0);
    expect(units).toHaveLength(7);
    const m = metricsOf(units);
    expect(m.unweighted).toMatchObject({ cstar: 5, cstar17: 4, cstar8: 1, predicted: 5, correct: 2, correct17: 2 });
    expect(m.unweighted.recall).toBeCloseTo(0.4);
    expect(m.unweighted.recall17).toBeCloseTo(0.5);
    expect(m.unweighted.precision).toBeCloseTo(0.4);
    expect(m.unweighted.theta).toBeCloseTo(0.2);
    expect(m.weighted).toMatchObject({ cstar: 34, cstar17: 24, cstar8: 10, predicted: 34, correct: 12 });
    expect(m.weighted.recall17).toBeCloseTo(0.5);
    expect(m.weighted.precision).toBeCloseTo(12 / 34);
    expect(m.byCase).toEqual({
      "1": { n: 1, correct: 1, recall: 1 },
      "2": { n: 2, correct: 1, recall: 0.5 },
      "5": { n: 1, correct: 0, recall: 0 },
      "8": { n: 1, correct: 0, recall: 0 },
    });
  });

  it("aligns sites by line range, once each, and counts an alternative as a hit", () => {
    const candidates: SampleFrame["candidates"] = new Map([
      ["r:a.ts:10", { stratum: "http", split: "dev", component: "web" }],
      ["r:a.ts:11", { stratum: "http", split: "dev", component: "web" }],
      ["r:a.ts:20", { stratum: "http", split: "test", component: "web" }],
    ]);
    const frame: SampleFrame = { candidates, sampled: ["r:a.ts:10", "r:a.ts:11", "r:a.ts:20"] };
    // one call over lines 10–12; line 11 is the not-a-site line of its argument object
    const s = site(10, 12);
    const labels = [label(11, { isSite: false, type: null, reason: "not-a-call" }), label(10, { endLine: 12, target: "http:POST:/api/v1/groups.addOwner@rocketchat", caseNo: 3 })];
    const links = new Map([link(s, "linked", "http:POST:/api/v1/channels.addOwner@rocketchat", ["http:POST:/api/v1/channels.addOwner@rocketchat", "http:POST:/api/v1/groups.addOwner@rocketchat"])]);
    const { units } = alignUnits(frame, "dev", labels, [s], links);
    expect(units.map((u) => [u.unit, u.site, u.correct, u.predicted])).toEqual([
      ["r:a.ts:10", s.id, true, true],
      ["r:a.ts:11", null, false, false],
    ]);
  });

  it("aligns a labelled call with a site of its own type when one line holds two calls", () => {
    const candidates: SampleFrame["candidates"] = new Map([["r:a.ts:5", { stratum: "broker", split: "dev", component: "web" }]]);
    const frame: SampleFrame = { candidates, sampled: ["r:a.ts:5"] };
    const db = { ...site(5), id: "r:a.ts:5:20", col: 20, type: "db" as const };
    const broker = { ...site(5), id: "r:a.ts:5:6", col: 26, type: "broker" as const };
    const links = new Map([link(db, "linked", "coll:-:users@mongo"), link(broker, "linked", "event:-:user.nameChanged@*")]);
    const { units } = alignUnits(frame, "dev", [label(5, { type: "broker", target: "event:-:user.nameChanged@*", caseNo: 1 })], [db, broker], links);
    expect(units[0]).toMatchObject({ site: broker.id, correct: true });
  });

  it("weights strata by the lines labelled so far", () => {
    const candidates: SampleFrame["candidates"] = new Map();
    for (let i = 1; i <= 20; i++) candidates.set(`r:a.ts:${i}`, { stratum: "http", split: "dev", component: "web" });
    const frame: SampleFrame = { candidates, sampled: ["r:a.ts:1", "r:a.ts:2", "r:a.ts:3", "r:a.ts:4"] };
    const { units, pending } = alignUnits(frame, "dev", [label(1, { target: "http:GET:/a@api", caseNo: 1 }), label(2, { target: "NONE", reason: "external" })], [], new Map());
    expect(pending).toBe(2);
    // 20 candidates, 2 labelled: each labelled line stands for 10
    expect(units.map((u) => u.weight)).toEqual([10, 10]);
  });

  it("writes the site results and appends to the audit log", () => {
    const t = toy();
    const { units, pending } = alignUnits(t.frame, "dev", t.labels, t.sites, t.links);
    const root = tempDir();
    const audit = join(root, "audit.jsonl");
    const dir = writeEvaluation(root, "toy", { run: "no-llm", compare: "key", split: "dev", annotator: "A", units, pending, metrics: metricsOf(units) }, { configHash: "h", toolSha: null }, audit);
    const csv = readFileSync(join(dir, "site_results.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toMatch(/^unit,file,repo,path,line,stratum,weight,/);
    expect(csv).toHaveLength(8);
    // the audit entry says how predictions met labels
    expect(JSON.parse(readFileSync(audit, "utf8").trim())).toMatchObject({ target: "toy", run: "no-llm", compare: "key", split: "dev", units: 7 });
  });
});
