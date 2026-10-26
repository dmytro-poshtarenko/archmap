import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataLayout } from "../../src/core/paths.js";
import { gapReport, wilsonUpper } from "../../src/eval/gap.js";
import { saveLabel } from "../../src/labelling/labels.js";
import { openCandidates, openLabels } from "../../src/labelling/store.js";
import { openDb } from "../../src/store/db.js";
import { tempDir } from "../helpers.js";

describe("the gap check", () => {
  it("bounds a miss rate of zero by the Wilson interval", () => {
    expect(wilsonUpper(0, 42)).toBeCloseTo(0.0838, 4);
    expect(wilsonUpper(0, 0)).toBe(1);
    expect(wilsonUpper(5, 10)).toBeGreaterThan(0.5);
  });

  it("counts the sites of files read in full against the candidates and the method's call sites", () => {
    const layout = dataLayout(join(tempDir(), "data"));
    const candidates = openCandidates(layout, "t");
    const labels = openLabels(layout, "t", "dev", "annotate", false);
    const method = openDb(join(tempDir(), "t.sqlite"));
    // two files drawn for the gap check; only a.ts was read in full
    const gap = candidates.prepare("INSERT INTO gap_file(repo, path, split, rank) VALUES (?, ?, 'dev', ?)");
    gap.run("r", "a.ts", 1);
    gap.run("r", "b.ts", 2);
    labels.prepare("INSERT INTO gap_review(repo, path, annotator, done_at) VALUES ('r', 'a.ts', 'A', 'now')").run();
    // the text search found lines 10 and 30; the method found the call on lines 10–11 and 50
    const candidate = candidates.prepare("INSERT INTO candidate(id, repo, path, line, split, component, stratum, patterns, text_sha) VALUES (?, 'r', 'a.ts', ?, 'dev', NULL, 'http', '[]', 'x')");
    candidate.run("r:a.ts:10", 10);
    candidate.run("r:a.ts:30", 30);
    method.prepare("INSERT INTO repo(id, url, sha, role, licence) VALUES ('r', 'u', 's', 'main', 'MIT')").run();
    method.prepare("INSERT INTO file(repo_id, path, sha256, bytes, loc, licence, publishable, split) VALUES ('r', 'a.ts', 'h', 1, 1, 'MIT', 1, 'dev')").run();
    const site = method.prepare(
      "INSERT INTO call_site(id, repo, path, line, end_line, col, type, role, detector, address, display, components) VALUES (?, 'r', 'a.ts', ?, ?, 1, 'http', 'request', 'd', '{}', 'x', '[]')",
    );
    site.run("r:a.ts:10:1", 10, 11);
    site.run("r:a.ts:50:1", 50, 50);
    const label = (line: number, target: string | null, endLine: number | null = null) =>
      saveLabel(
        labels,
        { item: `r:a.ts:${line}`, repo: "r", path: "a.ts", line, endLine, origin: "gap", isSite: true, type: "http", target, caseNo: target && target !== "NONE" ? 1 : null, reason: target === "NONE" ? "external" : null, note: null },
        "A",
        "g",
      );
    label(11, "http:GET:/a@api", 12); // both found it: candidate line 10 is outside, the call 10–11 overlaps
    label(30, "http:GET:/b@api"); // only the text search
    label(50, "NONE"); // only the method, and it has no target
    const r = gapReport({ candidates, labels: { dev: labels }, method, annotator: "A" });
    expect(r).toMatchObject({ files: 2, reviewed: 1, all: { sites: 3, inFrame: 1, byMethod: 2 }, targeted: { sites: 2, inFrame: 1, byMethod: 1 } });
    expect(r.sites.map((s) => [s.line, s.inFrame, s.byMethod])).toEqual([
      [11, false, true],
      [30, true, false],
      [50, false, true],
    ]);
  });
});
