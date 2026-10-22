import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataLayout } from "../../src/core/paths.js";
import { canonicalTargetKey, parseTargetKey } from "../../src/labelling/catalog.js";
import { exportLabels, importJsonl, toCsv, toJsonl } from "../../src/labelling/exchange.js";
import { agreement, cohensKappa, getLabel, LabelError, listLabels, saveLabel } from "../../src/labelling/labels.js";
import { LabelsLockedError, openLabels } from "../../src/labelling/store.js";
import { tempDir } from "../helpers.js";

const site = (overrides: Record<string, unknown> = {}) => ({
  item: "main:a.ts:3",
  repo: "main",
  path: "a.ts",
  line: 3,
  endLine: null,
  origin: "sample",
  isSite: true,
  type: "http",
  target: "http:GET:/api/v1/rooms.info@rocketchat",
  caseNo: 1,
  reason: null,
  note: null,
  ...overrides,
});

function labelsDb() {
  return openLabels(dataLayout(join(tempDir(), "data")), "t", "dev", "annotate", false);
}

describe("target keys", () => {
  it("follow the grammar of the guide", () => {
    for (const key of [
      "http:GET:/api/v1/rooms.info@rocketchat",
      "ddp:call:UserPresence:away@ddp-streamer-service",
      "ddp:sub:notify-room@ddp-streamer-service",
      "action:-:presence.setStatus@presence-service",
      "event:-:user.nameChanged@*",
      "coll:-:users@mongo",
      "timer:-:NPS@rocketchat",
    ]) {
      expect(parseTargetKey(key)).not.toHaveProperty("error");
    }
    for (const key of ["http:FETCH:/x@a", "http:GET:x@a", "ddp:-:m@a", "action:-:nodot@a", "event:-:e@a", "coll:-:users@*", "NONE"]) {
      expect(parseTargetKey(key)).toHaveProperty("error");
    }
  });

  it("allow single spaces inside a name, as job names have", () => {
    expect(parseTargetKey("timer:-:Prune old messages by retention policy@rocketchat")).toMatchObject({ name: "Prune old messages by retention policy" });
    for (const key of ["timer:-: NPS@rocketchat", "timer:-:NPS @rocketchat", "timer:-:Prune  old@rocketchat"]) {
      expect(parseTargetKey(key)).toHaveProperty("error");
    }
  });

  it("compare HTTP routes regardless of parameter names", () => {
    expect(canonicalTargetKey("http:GET:/api/v1/livechat/agents/:uid/departments@rocketchat")).toBe(
      canonicalTargetKey("http:GET:/api/v1/livechat/agents/:agentId/departments@rocketchat"),
    );
    expect(canonicalTargetKey("ddp:call:a:b@x")).toBe("ddp:call:a:b@x");
  });
});

describe("labels", () => {
  it("accept the three kinds of answer and reject inconsistent ones", () => {
    const db = labelsDb();
    expect(saveLabel(db, site(), "A", "1.0").caseNo).toBe(1);
    expect(saveLabel(db, site({ target: "NONE", caseNo: null, reason: "external" }), "A", "1.0").target).toBe("NONE");
    expect(saveLabel(db, site({ isSite: false, type: null, target: null, caseNo: null, reason: "declaration" }), "A", "1.0").isSite).toBe(false);
    const bad = [
      site({ caseNo: null }),
      site({ target: "NONE", caseNo: 2, reason: "external" }),
      site({ target: "NONE", caseNo: null, reason: "because" }),
      site({ isSite: false, reason: "declaration" }),
      site({ target: "http:GET:rooms.info@rocketchat" }),
      site({ item: "main:a.ts:4" }),
      site({ endLine: 2 }),
    ];
    for (const input of bad) expect(() => saveLabel(db, input, "A", "1.0")).toThrow(LabelError);
  });

  it("keep one label per annotator and item, with the history of saves", () => {
    const db = labelsDb();
    saveLabel(db, site(), "A", "1.0");
    saveLabel(db, site({ caseNo: 2, endLine: 5 }), "A", "1.0");
    saveLabel(db, site({ caseNo: 3 }), "B", "1.0");
    expect(getLabel(db, "main:a.ts:3", "A")).toMatchObject({ caseNo: 2, endLine: 5, isSite: true });
    expect(listLabels(db)).toHaveLength(2);
    expect(db.prepare("SELECT count(*) FROM label_event").pluck().get()).toBe(3);
  });

  it("are locked by split before the freeze", () => {
    const layout = dataLayout(join(tempDir(), "data"));
    expect(() => openLabels(layout, "t", "test", "annotate", false)).not.toThrow();
    expect(() => openLabels(layout, "t", "test", "evaluate", false)).toThrow(LabelsLockedError);
    expect(() => openLabels(layout, "t", "heldout", "annotate", false)).toThrow(LabelsLockedError);
    expect(() => openLabels(layout, "t", "test", "evaluate", true)).not.toThrow();
    expect(() => openLabels(layout, "t", "dev", "evaluate", false)).not.toThrow();
  });
});

describe("agreement", () => {
  it("matches a worked example of Cohen's kappa", () => {
    // 50 items: both yes 20, A yes/B no 5, A no/B yes 10, both no 15 -> po 0.7, pe 0.5, kappa 0.4
    const pairs: Array<[string, string]> = [
      ...Array.from({ length: 20 }, (): [string, string] => ["yes", "yes"]),
      ...Array.from({ length: 5 }, (): [string, string] => ["yes", "no"]),
      ...Array.from({ length: 10 }, (): [string, string] => ["no", "yes"]),
      ...Array.from({ length: 15 }, (): [string, string] => ["no", "no"]),
    ];
    const k = cohensKappa(pairs);
    expect(k.observed).toBeCloseTo(0.7);
    expect(k.expected).toBeCloseTo(0.5);
    expect(k.kappa).toBeCloseTo(0.4);
    expect(cohensKappa([["a", "a"]]).kappa).toBeNull();
  });

  it("compares targets and cases of the items both annotators labelled", () => {
    const db = labelsDb();
    saveLabel(db, site(), "A", "1.0");
    saveLabel(db, site(), "B", "1.0");
    saveLabel(db, site({ item: "main:a.ts:9", line: 9, caseNo: 3 }), "A", "1.0");
    saveLabel(db, site({ item: "main:a.ts:9", line: 9, caseNo: 2 }), "B", "1.0");
    saveLabel(db, site({ item: "main:a.ts:12", line: 12 }), "A", "1.0");
    const r = agreement(db, "A", "B");
    expect(r.target.n).toBe(2);
    expect(r.target.observed).toBe(1);
    expect(r.case.observed).toBe(0.5);
    expect(r.disagreements.map((d) => d.item)).toEqual(["main:a.ts:9"]);
  });
});

describe("export and import", () => {
  it("round-trip without code and keep CSV cells intact", () => {
    const db = labelsDb();
    saveLabel(db, site({ note: "secret code would never be here" }), "A", "1.0");
    saveLabel(db, site({ item: "main:b,c.ts:1", path: "b,c.ts", line: 1, target: "NONE", caseNo: null, reason: "intra" }), "A", "1.0");
    const rows = exportLabels(db, () => "a".repeat(40));
    expect(Object.keys(rows[0] ?? {})).not.toContain("note");
    expect(toCsv(rows)).toContain('"b,c.ts"');
    const other = labelsDb();
    expect(importJsonl(other, toJsonl(rows), { annotator: "B" })).toBe(2);
    expect(listLabels(other, "B").map((l) => [l.item, l.target, l.caseNo])).toEqual([
      ["main:a.ts:3", "http:GET:/api/v1/rooms.info@rocketchat", 1],
      ["main:b,c.ts:1", "NONE", null],
    ]);
    expect(() => importJsonl(other, '{"repo":"main"}\n')).toThrow(/line 1/);
  });
});
