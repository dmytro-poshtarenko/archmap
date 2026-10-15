import { ts } from "ts-morph";
import { z } from "zod";
import type { LlmConfig } from "../../config/schema.js";
import type { RouteDecl } from "../../core/types.js";
import { loadTemplate, render, TEMPLATES } from "../prompts.js";
import type { LlmAnswer, LlmRequest } from "../types.js";

export const RouteAnswer = z.object({
  routes: z.array(
    z.object({
      kind: z.enum(["http", "ddp-method", "ddp-sub", "broker-action"]),
      /** HTTP method for `http`, otherwise null. */
      method: z.string().nullable(),
      name: z.string(),
      line: z.number().int(),
    }),
  ),
});
export type RouteAnswer = z.infer<typeof RouteAnswer>;

export interface SourceFile {
  repo: string;
  path: string;
  text: string;
  /** Parts running the file (import graph of the extraction). */
  components: string[];
}

/** A part of a file sent in one request: its first line and its numbered text. */
export interface Chunk {
  file: SourceFile;
  index: number;
  count: number;
  firstLine: number;
  lastLine: number;
  code: string;
}

const MAX_TOKENS = 8000;

/**
 * Server files sent to route extraction: files that no client runs and
 * whose text matches one of the configured hints (declarations of routes,
 * methods, publications, streams).
 */
export function filesForExtraction(files: SourceFile[], hints: string[], clientParts: Set<string>): SourceFile[] {
  const patterns = hints.map((h) => new RegExp(h));
  return files.filter((f) => !f.components.some((c) => clientParts.has(c)) && patterns.some((p) => p.test(f.text)));
}

/** `  12| code` for every line, so answers can name lines. */
export function numbered(lines: string[], first: number): string {
  const width = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(width)}| ${l}`).join("\n");
}

/**
 * The parts of a file. Without chunking, or when the file fits, the whole
 * file. Otherwise top-level statements are packed into parts of at most
 * `maxTokens`; a statement too long on its own that is a call with an
 * object literal (`Meteor.methods({ … })`) is split between its properties,
 * each part repeating the opening line of the call.
 */
export function chunksOf(file: SourceFile, chunking: LlmConfig["chunking"]): Chunk[] {
  const lines = file.text.split("\n");
  const whole: Chunk = { file, index: 0, count: 1, firstLine: 1, lastLine: lines.length, code: numbered(lines, 1) };
  if (!chunking.enabled || tokensOf(file.text) <= chunking.maxTokens) return [whole];
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const pieces: Array<{ from: number; to: number; header?: number[] }> = [];
  for (const st of sf.statements) {
    const from = lineOf(st.getStart(sf));
    const to = lineOf(st.getEnd());
    const text = lines.slice(from - 1, to).join("\n");
    const object = tokensOf(text) > chunking.maxTokens ? objectArgument(st) : undefined;
    if (!object) {
      pieces.push({ from, to });
      continue;
    }
    const open = lineOf(object.getStart(sf));
    const header = Array.from({ length: open - from + 1 }, (_, i) => from + i);
    for (const prop of object.properties) pieces.push({ from: lineOf(prop.getStart(sf)), to: lineOf(prop.getEnd()), header });
  }
  const groups: Array<{ header?: number[]; ranges: Array<[number, number]> }> = [];
  let size = 0;
  for (const p of pieces) {
    const cost = tokensOf(lines.slice(p.from - 1, p.to).join("\n"));
    const last = groups.at(-1);
    if (last && size + cost <= chunking.maxTokens && last.header === p.header) {
      last.ranges.push([p.from, p.to]);
      size += cost;
    } else {
      groups.push({ ...(p.header ? { header: p.header } : {}), ranges: [[p.from, p.to]] });
      size = cost + (p.header ? tokensOf(p.header.map((n) => lines[n - 1]).join("\n")) : 0);
    }
  }
  return groups.map((g, index) => {
    const parts: string[] = [];
    if (g.header) parts.push(numbered(g.header.map((n) => lines[n - 1] ?? ""), g.header[0] ?? 1), "    …");
    for (const [from, to] of g.ranges) parts.push(numbered(lines.slice(from - 1, to), from));
    const firstLine = g.header?.[0] ?? g.ranges[0]?.[0] ?? 1;
    const lastLine = g.ranges.at(-1)?.[1] ?? firstLine;
    return { file, index, count: groups.length, firstLine, lastLine, code: parts.join("\n") };
  });
}

function objectArgument(st: ts.Statement): ts.ObjectLiteralExpression | undefined {
  if (!ts.isExpressionStatement(st)) return undefined;
  let e: ts.Expression = st.expression;
  if (ts.isAwaitExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return undefined;
  return e.arguments.find((a): a is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(a));
}

/** Rough token count of source text (about three characters per token). */
export function tokensOf(text: string): number {
  return Math.ceil(text.length / 3);
}

export function extractionRequest(chunk: Chunk, project: string, effort: LlmRequest["effort"], repeat = 0): LlmRequest<RouteAnswer> {
  const t = loadTemplate(TEMPLATES.extract);
  const path = `${chunk.file.repo}:${chunk.file.path}`;
  return {
    task: "extract-routes",
    template: TEMPLATES.extract,
    subject: chunk.count > 1 ? `${path}#${chunk.index + 1}/${chunk.count}` : path,
    system: render(t.system, { project }),
    user: render(t.user, { path: chunk.file.path, code: chunk.code }),
    schema: RouteAnswer,
    maxTokens: MAX_TOKENS,
    effort,
    repeat,
  };
}

/**
 * Route declarations from an answer, in the method's terms: kind, method
 * (`call` or `sub` for DDP), template, location. Lines outside the part
 * sent are clamped into it; HTTP paths get a leading slash and lose a
 * trailing one.
 */
export function routesFromAnswer(chunk: Chunk, answer: LlmAnswer<RouteAnswer>, model: string): RouteDecl[] {
  if (!answer.parsed) return [];
  const out: RouteDecl[] = [];
  for (const r of answer.parsed.routes) {
    const name = r.name.trim();
    if (name === "") continue;
    const line = Math.min(Math.max(r.line, chunk.firstLine), chunk.lastLine);
    const base = { repo: chunk.file.repo, path: chunk.file.path, line, col: 1, detector: `llm:${model}`, source: "llm" as const, components: chunk.file.components, extra: null };
    if (r.kind === "http") {
      const template = `/${name.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\/+/, "").replace(/\/+$/, "")}`;
      out.push({ ...base, id: "", kind: "http", method: (r.method ?? "*").toUpperCase(), template });
    } else if (r.kind === "broker-action") {
      out.push({ ...base, id: "", kind: "broker-action", method: null, template: name });
    } else {
      out.push({ ...base, id: "", kind: "ddp-method", method: r.kind === "ddp-sub" ? "sub" : "call", template: name });
    }
  }
  return out;
}

/** Ids unique within the extracted routes: `<repo>:<path>:<line>:1~llm`, then `#2`, `#3`. */
export function assignIds(routes: RouteDecl[]): RouteDecl[] {
  const seen = new Set<string>();
  const unique = new Map<string, RouteDecl>();
  for (const r of routes) {
    const key = `${r.repo}:${r.path}|${r.kind}|${r.method}|${r.template}`;
    if (!unique.has(key)) unique.set(key, r);
  }
  return [...unique.values()].map((r) => {
    const base = `${r.repo}:${r.path}:${r.line}:1~llm`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}#${n}`;
    seen.add(id);
    return { ...r, id };
  });
}
