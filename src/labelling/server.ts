import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { toolRoot } from "../core/paths.js";
import type { Db } from "../store/db.js";
import { addManualEntry, hasCatalogKey, searchCatalog } from "./catalog.js";
import { getLabel, LabelError, listLabels, NONE_REASONS, NOT_SITE_REASONS, saveLabel } from "./labels.js";
import type { Snapshot } from "./snapshot.js";
import type { Split } from "./store.js";

export interface ServeOptions {
  host?: string;
  port: number;
  annotator: string;
  /** The second annotator sees only the items drawn for double labelling. */
  role: "primary" | "second";
  guide: { version: string; path: string };
  snapshot: Snapshot;
  candidates: Db;
  /** Label databases this session may write, opened for annotation. */
  labels: Partial<Record<Split, Db>>;
}

const CONTEXT_LINES = 40;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 64 * 1024;

/**
 * The local labelling interface. It reads the inventoried files, the sample,
 * the catalog and the annotator's own labels, and nothing the method produced:
 * the annotator never sees the tool's answer for a site.
 */
export function startLabellingServer(opts: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const page = () => readFileSync(join(toolRoot, "labelling", "ui", "index.html"), "utf8");
  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown> | unknown> = {
    "GET /api/state": () => state(opts),
    "GET /api/queue": (_req, url) => queue(opts, splitParam(url, opts)),
    "GET /api/item": (_req, url) =>
      item(opts, splitParam(url, opts), required(url, "item"), url.searchParams.get("full") === "1", url.searchParams.get("blind") === "1"),
    "POST /api/label": async (req, url) => {
      const split = splitParam(url, opts);
      const body = (await readJson(req)) as Record<string, unknown>;
      // A sampled line met again in a gap-check file stays a sample label.
      const existing = getLabel(db(opts, split), String(body.item ?? ""), opts.annotator);
      if (existing?.origin === "sample" && body.origin === "gap") body.origin = "sample";
      checkItem(opts, split, body);
      return saveLabel(db(opts, split), body, opts.annotator, opts.guide.version);
    },
    "GET /api/catalog": (_req, url) => searchCatalog(opts.candidates, url.searchParams.get("q") ?? "", 40),
    "POST /api/catalog": async (req) => {
      const body = (await readJson(req)) as { key?: unknown; note?: unknown };
      try {
        return addManualEntry(opts.candidates, String(body.key ?? ""), body.note ? String(body.note) : `added by ${opts.annotator}`);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
    },
    "GET /api/gap": () => gapFiles(opts),
    "GET /api/file": (_req, url) => file(opts, required(url, "repo"), required(url, "path")),
    "POST /api/gap/done": async (req) => {
      const body = (await readJson(req)) as { repo?: string; path?: string };
      const gap = opts.candidates.prepare("SELECT split FROM gap_file WHERE repo = ? AND path = ?").get(body.repo, body.path) as
        | { split: Split }
        | undefined;
      if (!gap) throw new HttpError(404, "not a gap-check file");
      db(opts, gap.split)
        .prepare("INSERT OR REPLACE INTO gap_review(repo, path, annotator, done_at) VALUES (?, ?, ?, ?)")
        .run(body.repo, body.path, opts.annotator, new Date().toISOString());
      return { ok: true };
    },
    "GET /guide": () => readFileSync(opts.guide.path, "utf8"),
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only pages served from this loopback address may talk to it: another site
    // in the same browser can neither read the code (DNS rebinding) nor post
    // labels with a form-like request that skips the CORS preflight.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(host)) return send(res, 403, { error: "forbidden host" });
    if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return send(res, 415, { error: "expected application/json" });
    }
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, page(), "text/html; charset=utf-8");
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: "not found" });
    Promise.resolve()
      .then(() => handler(req, url))
      .then((result) =>
        typeof result === "string" ? send(res, 200, result, "text/markdown; charset=utf-8") : send(res, 200, result),
      )
      .catch((error: unknown) => {
        if (error instanceof HttpError) return send(res, error.status, { error: error.message });
        if (error instanceof LabelError) return send(res, 400, { error: error.message });
        return send(res, 500, { error: (error as Error).message });
      });
  });
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${opts.host ?? "127.0.0.1"}:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

function required(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `missing ${name}`);
  return value;
}

function splitParam(url: URL, opts: ServeOptions): Split {
  const split = url.searchParams.get("split") ?? "dev";
  if (!(split in opts.labels)) throw new HttpError(403, `the ${split} split is not open in this session`);
  return split as Split;
}

function db(opts: ServeOptions, split: Split): Db {
  const handle = opts.labels[split];
  if (!handle) throw new HttpError(403, `the ${split} split is not open in this session`);
  return handle;
}

interface QueueRow {
  candidate: string;
  rank: number;
  double: number;
  repo: string;
  path: string;
  line: number;
  split: Split;
  component: string | null;
  stratum: string;
  patterns: string;
}

function sampleRows(opts: ServeOptions, split: Split): QueueRow[] {
  const pool = split === "heldout" ? "heldout" : "main";
  const rows = opts.candidates
    .prepare(
      `SELECT s.candidate, s.rank, s.double, c.repo, c.path, c.line, c.split, c.component, c.stratum, c.patterns
       FROM sample s JOIN candidate c ON c.id = s.candidate WHERE s.pool = ? AND c.split = ? ORDER BY s.rank`,
    )
    .all(pool, split) as QueueRow[];
  return opts.role === "second" ? rows.filter((r) => r.double === 1) : rows;
}

function state(opts: ServeOptions) {
  const splits = Object.fromEntries(
    (Object.keys(opts.labels) as Split[]).map((split) => {
      const rows = sampleRows(opts, split);
      const done = new Set(listLabels(db(opts, split), opts.annotator).map((l) => l.item));
      return [split, { total: rows.length, done: rows.filter((r) => done.has(r.candidate)).length }];
    }),
  );
  return {
    annotator: opts.annotator,
    role: opts.role,
    guide: opts.guide.version,
    splits,
    reasons: { notSite: NOT_SITE_REASONS, none: NONE_REASONS },
  };
}

function queue(opts: ServeOptions, split: Split) {
  const labels = new Map(listLabels(db(opts, split), opts.annotator).map((l) => [l.item, l]));
  return sampleRows(opts, split).map((r) => {
    const label = labels.get(r.candidate);
    return {
      item: r.candidate,
      rank: r.rank,
      double: r.double === 1,
      repo: r.repo,
      path: r.path,
      line: r.line,
      component: r.component,
      stratum: r.stratum,
      done: label !== undefined,
      summary: label ? (label.isSite ? `${label.target}${label.caseNo ? ` #${label.caseNo}` : ""}` : `not a site: ${label.reason}`) : null,
    };
  });
}

function item(opts: ServeOptions, split: Split, id: string, full: boolean, blind: boolean) {
  const row = opts.candidates
    .prepare("SELECT id, repo, path, line, split, component, stratum, patterns FROM candidate WHERE id = ?")
    .get(id) as Omit<QueueRow, "candidate" | "rank" | "double"> & { id: string } | undefined;
  const parsed = row ?? parseItem(opts, id);
  if (parsed.split !== split) throw new HttpError(400, `${id} belongs to the ${parsed.split} split`);
  const lines = opts.snapshot.read(parsed.repo, parsed.path).split("\n");
  const from = full ? 1 : Math.max(1, parsed.line - CONTEXT_LINES);
  const to = full ? lines.length : Math.min(lines.length, parsed.line + CONTEXT_LINES);
  const label = getLabel(db(opts, split), id, opts.annotator) ?? null;
  return {
    item: id,
    repo: parsed.repo,
    path: parsed.path,
    line: parsed.line,
    split: parsed.split,
    component: parsed.component,
    stratum: "stratum" in parsed ? parsed.stratum : null,
    patterns: "patterns" in parsed && typeof parsed.patterns === "string" ? (JSON.parse(parsed.patterns) as string[]) : [],
    code: { from, lines: lines.slice(from - 1, to), total: lines.length },
    // Other candidate lines nearby, so a call spanning several of them is labelled once.
    candidateLines: blind
      ? []
      : (opts.candidates
          .prepare("SELECT line FROM candidate WHERE repo = ? AND path = ? AND line BETWEEN ? AND ? ORDER BY line")
          .pluck()
          .all(parsed.repo, parsed.path, from, to) as number[]),
    label,
    targetKnown: label?.target && label.target !== "NONE" ? hasCatalogKey(opts.candidates, label.target) : null,
  };
}

/** A site that is not a candidate, found while reading a gap-check file. */
function parseItem(opts: ServeOptions, id: string) {
  const m = /^([^:]+):(.+):(\d+)$/.exec(id);
  if (!m) throw new HttpError(400, "item must be '<repo>:<path>:<line>'");
  const [, repo = "", path = "", line = "0"] = m;
  const f = opts.snapshot.file(repo, path);
  if (!f) throw new HttpError(404, `${repo}:${path} is not in the inventory`);
  return { id, repo, path, line: Number(line), split: f.split, component: f.component };
}

/** Labels may only be saved for sampled items, or for any line of a gap-check file. */
function checkItem(opts: ServeOptions, split: Split, body: Record<string, unknown>): void {
  const id = String(body.item ?? "");
  const origin = String(body.origin ?? "");
  if (origin === "sample") {
    const sampled = sampleRows(opts, split).some((r) => r.candidate === id);
    if (!sampled) throw new HttpError(400, `${id} is not in this annotator's ${split} sample`);
    return;
  }
  if (origin === "gap") {
    const gap = opts.candidates.prepare("SELECT split FROM gap_file WHERE repo = ? AND path = ?").get(body.repo, body.path) as
      | { split: Split }
      | undefined;
    if (!gap || gap.split !== split) throw new HttpError(400, `${String(body.repo)}:${String(body.path)} is not a ${split} gap-check file`);
    return;
  }
  throw new HttpError(400, "the interface saves sample and gap-check labels only");
}

function gapFiles(opts: ServeOptions) {
  const files = opts.candidates.prepare("SELECT repo, path, split, rank FROM gap_file ORDER BY rank").all() as Array<{
    repo: string;
    path: string;
    split: Split;
    rank: number;
  }>;
  return files
    .filter((f) => f.split in opts.labels)
    .map((f) => {
      const labelsDb = db(opts, f.split);
      const reviewed = labelsDb
        .prepare("SELECT 1 FROM gap_review WHERE repo = ? AND path = ? AND annotator = ?")
        .get(f.repo, f.path, opts.annotator);
      // Which lines are candidates is not shown: the file is read blind, so the
      // share of sites the text search found is not inflated by the reading.
      const sites = listLabels(labelsDb, opts.annotator).filter(
        (l) => l.repo === f.repo && l.path === f.path && (l.origin === "gap" || l.origin === "sample"),
      );
      return { ...f, reviewed: reviewed !== undefined, sites: sites.map((s) => ({ line: s.line, target: s.target, isSite: s.isSite })) };
    });
}

function file(opts: ServeOptions, repo: string, path: string) {
  const isGap = opts.candidates.prepare("SELECT 1 FROM gap_file WHERE repo = ? AND path = ?").get(repo, path) !== undefined;
  if (!isGap) throw new HttpError(403, "only gap-check files are shown in full this way");
  const f = opts.snapshot.file(repo, path);
  return { repo, path, split: f?.split, component: f?.component ?? null, lines: opts.snapshot.read(repo, path).split("\n") };
}
