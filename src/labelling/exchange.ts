import type { Db } from "../store/db.js";
import { type Label, listLabels, saveLabel } from "./labels.js";

/**
 * Columns of the published labels: where the site is and what it was
 * labelled, never the code itself, so labels of sites in code that may not be
 * published (Rocket.Chat EE) can still be released.
 */
export const EXPORT_COLUMNS = [
  "repo",
  "sha",
  "path",
  "line",
  "end_line",
  "annotator",
  "origin",
  "is_site",
  "type",
  "target",
  "case",
  "reason",
  "guide",
] as const;

export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string | number | null>;

export function exportRows(labels: Label[], shaOf: (repo: string) => string): ExportRow[] {
  return labels.map((l) => ({
    repo: l.repo,
    sha: shaOf(l.repo),
    path: l.path,
    line: l.line,
    end_line: l.endLine,
    annotator: l.annotator,
    origin: l.origin,
    is_site: l.isSite ? 1 : 0,
    type: l.type,
    target: l.target,
    case: l.caseNo,
    reason: l.reason,
    guide: l.guide,
  }));
}

export function toCsv(rows: ExportRow[]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[EXPORT_COLUMNS.join(","), ...rows.map((r) => EXPORT_COLUMNS.map((c) => cell(r[c])).join(","))].join("\n")}\n`;
}

export function toJsonl(rows: ExportRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
}

/**
 * Imports labels exported by `label export` (JSON lines), for example from a
 * second annotator who labelled on another machine. Each row is validated
 * like a label saved in the interface; the annotator and guide of the row are
 * kept unless overridden.
 */
export function importJsonl(db: Db, text: string, opts: { annotator?: string; now?: Date } = {}): number {
  let count = 0;
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  db.transaction(() => {
    for (const [i, line] of lines.entries()) {
      let row: ExportRow;
      try {
        row = JSON.parse(line) as ExportRow;
      } catch {
        throw new Error(`line ${i + 1}: not JSON`);
      }
      const input = {
        item: `${row.repo}:${row.path}:${row.line}`,
        repo: String(row.repo),
        path: String(row.path),
        line: Number(row.line),
        endLine: row.end_line === null || row.end_line === undefined ? null : Number(row.end_line),
        origin: row.origin,
        isSite: row.is_site === 1,
        type: row.type,
        target: row.target,
        caseNo: row.case === null ? null : Number(row.case),
        reason: row.reason,
        note: null,
      };
      try {
        saveLabel(db, input, opts.annotator ?? String(row.annotator), String(row.guide), opts.now);
      } catch (error) {
        throw new Error(`line ${i + 1}: ${(error as Error).message}`);
      }
      count++;
    }
  })();
  return count;
}

export function exportLabels(db: Db, shaOf: (repo: string) => string, annotator?: string): ExportRow[] {
  return exportRows(listLabels(db, annotator), shaOf);
}
