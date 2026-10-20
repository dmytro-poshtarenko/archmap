import type { TargetConfig } from "../config/schema.js";
import { hashOf } from "../core/hash.js";
import { countBy, inputsOf, matchingOf } from "../match/run.js";
import { type Db, getMeta, setMeta } from "../store/db.js";
import { classifySite } from "./features.js";

export interface ClassifySummary {
  sites: number;
  byCase: Record<string, number>;
  /** Resolution with every source, which the cases were read from. */
  byStatus: Record<string, number>;
  seconds: number;
}

/**
 * Predicts the case of every call site from the full evidence (rules,
 * infrastructure and any declarations the language model extracted) and
 * stores it with its features. Every variant of the method reports against
 * these cases.
 */
export function runClassify(db: Db, config: TargetConfig): ClassifySummary {
  const t0 = performance.now();
  const { resolver, sites, inputs } = matchingOf(db, config);
  const rows = sites.map((s) => classifySite(resolver, s));
  const insert = db.prepare(
    "INSERT INTO classification(site, case_no, features, status, target, reason) VALUES (@site, @caseNo, @features, @status, @target, @reason)",
  );
  db.transaction(() => {
    db.exec("DELETE FROM classification");
    for (const c of rows) {
      insert.run({ site: c.site, caseNo: c.caseNo, features: JSON.stringify(c.features), status: c.full.status, target: c.full.target, reason: c.full.reason });
    }
    setMeta(db, "classify.key", hashOf(inputs));
  })();
  return {
    sites: rows.length,
    byCase: countBy(rows, (r) => (r.caseNo === null ? "none" : String(r.caseNo))),
    byStatus: countBy(rows, (r) => r.full.status),
    seconds: Math.round((performance.now() - t0) / 10) / 100,
  };
}

/** Whether the stored cases were computed from the current extraction, infrastructure and rules. */
export function classificationCurrent(db: Db, config: TargetConfig): boolean {
  return getMeta(db, "classify.key") === hashOf(inputsOf(db, config));
}
