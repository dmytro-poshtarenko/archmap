import { z } from "zod";
import { InteractionType } from "../config/schema.js";
import type { Db } from "../store/db.js";
import { parseTargetKey } from "./catalog.js";

/** Why a candidate line is not a call site. */
export const NOT_SITE_REASONS = ["not-a-call", "declaration", "duplicate", "wrapper-internal", "other"] as const;
/** Why a call site has no target in the system. */
export const NONE_REASONS = ["external", "intra", "client-local", "other"] as const;
export const ORIGINS = ["sample", "gap", "blind", "manual"] as const;

export const LabelInput = z
  .strictObject({
    item: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().positive(),
    /** Last line of the call when it spans several lines. */
    endLine: z.number().int().positive().nullable().default(null),
    origin: z.enum(ORIGINS),
    isSite: z.boolean(),
    type: InteractionType.nullable(),
    target: z.string().nullable(),
    caseNo: z.number().int().min(1).max(8).nullable(),
    reason: z.string().nullable(),
    note: z.string().max(2000).nullable(),
  })
  .superRefine((l, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (l.item !== `${l.repo}:${l.path}:${l.line}`) issue("item must be '<repo>:<path>:<line>'");
    if (l.endLine !== null && l.endLine < l.line) issue("the call cannot end before it starts");
    if (!l.isSite) {
      if (l.type !== null || l.target !== null || l.caseNo !== null) issue("a line that is not a call site has no type, target or case");
      if (!NOT_SITE_REASONS.includes(l.reason as (typeof NOT_SITE_REASONS)[number])) {
        issue(`reason must be one of ${NOT_SITE_REASONS.join(", ")}`);
      }
      return;
    }
    if (l.type === null) issue("a call site needs its type");
    if (l.target === null) return issue("a call site needs a target key or NONE");
    if (l.target === "NONE") {
      if (l.caseNo !== null) issue("a site without a target has no case");
      if (!NONE_REASONS.includes(l.reason as (typeof NONE_REASONS)[number])) issue(`reason must be one of ${NONE_REASONS.join(", ")}`);
      return;
    }
    const key = parseTargetKey(l.target);
    if ("error" in key) issue(`target: ${key.error}`);
    if (l.caseNo === null) issue("a site with a target needs its case number");
    if (l.reason !== null) issue("a site with a target has no reason");
  });
export type LabelInput = z.infer<typeof LabelInput>;

export interface Label extends LabelInput {
  annotator: string;
  guide: string;
  updatedAt: string;
}

const COLUMNS = `item, annotator, repo, path, line, end_line AS endLine, origin, is_site AS isSite, type, target, case_no AS caseNo,
  reason, note, guide, updated_at AS updatedAt`;

function fromRow(row: Record<string, unknown>): Label {
  return { ...(row as unknown as Label), isSite: row.isSite === 1 };
}

/** Saves the annotator's label of an item (replacing an earlier one) and logs the save. */
export function saveLabel(db: Db, input: unknown, annotator: string, guide: string, now = new Date()): Label {
  const parsed = LabelInput.safeParse(input);
  if (!parsed.success) throw new LabelError(z.prettifyError(parsed.error));
  const label: Label = { ...parsed.data, annotator, guide, updatedAt: now.toISOString() };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO label(item, annotator, repo, path, line, end_line, origin, is_site, type, target, case_no, reason, note, guide, updated_at)
       VALUES (@item, @annotator, @repo, @path, @line, @endLine, @origin, @isSite, @type, @target, @caseNo, @reason, @note, @guide, @updatedAt)
       ON CONFLICT(item, annotator) DO UPDATE SET end_line = excluded.end_line, origin = excluded.origin, is_site = excluded.is_site, type = excluded.type,
         target = excluded.target, case_no = excluded.case_no, reason = excluded.reason, note = excluded.note,
         guide = excluded.guide, updated_at = excluded.updated_at`,
    ).run({ ...label, isSite: label.isSite ? 1 : 0 });
    db.prepare("INSERT INTO label_event(item, annotator, at, label) VALUES (?, ?, ?, ?)").run(
      label.item,
      annotator,
      label.updatedAt,
      JSON.stringify(label),
    );
  })();
  return label;
}

export class LabelError extends Error {}

export function getLabel(db: Db, item: string, annotator: string): Label | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM label WHERE item = ? AND annotator = ?`).get(item, annotator);
  return row ? fromRow(row as Record<string, unknown>) : undefined;
}

export function listLabels(db: Db, annotator?: string): Label[] {
  const rows = annotator
    ? db.prepare(`SELECT ${COLUMNS} FROM label WHERE annotator = ? ORDER BY repo, path, line`).all(annotator)
    : db.prepare(`SELECT ${COLUMNS} FROM label ORDER BY repo, path, line, annotator`).all();
  return (rows as Array<Record<string, unknown>>).map(fromRow);
}

export interface Kappa {
  n: number;
  observed: number;
  expected: number;
  /** Undefined when both annotators used a single category throughout. */
  kappa: number | null;
}

/** Cohen's kappa for two annotators' nominal labels of the same items. */
export function cohensKappa(pairs: Array<[string, string]>): Kappa {
  const n = pairs.length;
  if (n === 0) return { n, observed: 0, expected: 0, kappa: null };
  const a = new Map<string, number>();
  const b = new Map<string, number>();
  let agree = 0;
  for (const [x, y] of pairs) {
    if (x === y) agree++;
    a.set(x, (a.get(x) ?? 0) + 1);
    b.set(y, (b.get(y) ?? 0) + 1);
  }
  const observed = agree / n;
  let expected = 0;
  for (const [category, count] of a) expected += (count / n) * ((b.get(category) ?? 0) / n);
  return { n, observed, expected, kappa: expected === 1 ? null : (observed - expected) / (1 - expected) };
}

/**
 * Agreement between two annotators on the items both labelled: on the target
 * (a key, NONE, or "not a site") and, where both gave a key, on the case.
 */
export function agreement(db: Db, first: string, second: string) {
  const mine = new Map(listLabels(db, first).map((l) => [l.item, l]));
  const pairs = listLabels(db, second).flatMap((l) => {
    const other = mine.get(l.item);
    return other ? [[other, l] as const] : [];
  });
  const category = (l: Label) => (l.isSite ? (l.target ?? "") : "NOT-A-SITE");
  const target = cohensKappa(pairs.map(([x, y]) => [category(x), category(y)]));
  const withCase = pairs.filter(([x, y]) => x.caseNo !== null && y.caseNo !== null);
  const caseNo = cohensKappa(withCase.map(([x, y]) => [String(x.caseNo), String(y.caseNo)]));
  const disagreements = pairs
    .filter(([x, y]) => category(x) !== category(y) || (x.caseNo !== null && y.caseNo !== null && x.caseNo !== y.caseNo))
    .map(([x, y]) => ({ item: x.item, [first]: { target: category(x), case: x.caseNo }, [second]: { target: category(y), case: y.caseNo } }));
  return { target, case: caseNo, disagreements };
}
