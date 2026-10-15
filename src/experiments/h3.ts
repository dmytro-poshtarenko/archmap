import { ts } from "ts-morph";
import { canonicalTargetKey } from "../core/keys.js";
import { mulberry32, seedFrom, shuffle } from "../core/prng.js";
import { rocketchatApi } from "../extract/detectors/rocketchat-api.js";
import { Evaluator } from "../extract/evaluate.js";
import { Program } from "../extract/program.js";

/**
 * Hypothesis 3 asks whether the model misses more routes in longer files
 * while the routes stay the same. Real files cannot answer it (longer files
 * hold more routes), so synthetic variants of small REST controllers are
 * made: route names renamed (the model must read them, not recall them),
 * the length raised with realistic code that declares nothing, and every
 * variant checked by the method's own route detector.
 */

export interface ControllerRoute {
  method: string;
  /** Router prefix the name is served under, e.g. `/api/v1`. */
  prefix: string;
  /** Route name as declared (`calendar-events.list`) and its replacement. */
  original: string;
  renamed: string;
}

export interface Controller {
  id: string;
  /** `<repo>:<path>` of the source file. */
  source: string;
  /** Path the variants are presented under, made up like the route names. */
  path: string;
  text: string;
  routes: ControllerRoute[];
}

export interface VariantRoute {
  method: string;
  template: string;
  line: number;
  /** Relative position of the route in the file, 0 at the top and 1 at the end. */
  position: number;
}

export interface Variant {
  id: string;
  controller: string;
  series: "length" | "position";
  /** Length level (0 = the controller alone) or the place of the routes (start, middle, end). */
  level: string;
  path: string;
  text: string;
  chars: number;
  routes: VariantRoute[];
}

const SYLLABLES = ["ka", "lo", "mi", "ner", "vo", "tas", "pel", "ru", "zim", "dor", "fen", "qua", "bis", "tor", "lem", "sav", "gri", "hul", "jon", "wex"];

/** A pronounceable made-up word of about the length of `like`. */
function word(rng: () => number, like: string): string {
  let w = "";
  while (w.length < Math.max(3, like.length - 1)) w += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
  return w;
}

/**
 * Renames every word of a route name, keeping its separators and its
 * parameters: `livechat/visitor/:token` → `taslo/mipelru/:token`.
 */
export function renameRoute(name: string, rng: () => number, taken: Set<string>): string {
  for (;;) {
    const renamed = name.replace(/(:\w+)|([A-Za-z]+)/g, (_, param: string | undefined, w: string | undefined) => param ?? word(rng, w ?? ""));
    if (!taken.has(renamed)) {
      taken.add(renamed);
      return renamed;
    }
  }
}

/** Route names declared in a controller, by the method's detector. */
export function detectRoutes(path: string, text: string): Array<{ method: string; template: string; line: number }> {
  const program = new Program([{ repo: "h3", path, lang: path.endsWith(".tsx") ? "tsx" : "ts", component: null }], () => text);
  const evaluator = new Evaluator(program, { maxDepth: 8, valueSources: [] });
  const found = rocketchatApi.run({ program, evaluator, files: program.codeFiles() });
  const sf = program.source(`h3:${path}`);
  return found.map((r) => ({ method: r.method ?? "*", template: r.template, line: sf.getLineAndCharacterOfPosition(r.node.getStart(sf)).line + 1 }));
}

/**
 * A controller ready for the experiment: its route names renamed wherever
 * the file quotes them, and checked to still declare the same routes.
 */
export function prepareController(id: string, source: string, path: string, text: string, rng: () => number, taken: Set<string>): Controller {
  const declared = detectRoutes(path, text).map((r) => ({ ...r, ...splitPrefix(r.template) }));
  const names = [...new Set(declared.map((r) => r.name))];
  const renames = new Map(names.map((n) => [n, renameRoute(n, rng, taken)]));
  let renamed = text;
  for (const [from, to] of renames) renamed = renamed.replace(new RegExp(`(['"\`])${escape(from)}\\1`, "g"), (_, q: string) => `${q}${to}${q}`);
  const synthetic = path.replace(/[^/]+(\.tsx?)$/, (_, ext: string) => `${word(rng, "controller")}${ext}`);
  const routes = declared.map((r) => ({ method: r.method, prefix: r.prefix, original: r.name, renamed: renames.get(r.name) ?? r.name }));
  const check = detectRoutes(synthetic, renamed).map((r) => `${r.method} ${r.template}`).sort();
  const expected = routes.map((r) => `${r.method} ${r.prefix}/${r.renamed}`).sort();
  if (JSON.stringify(check) !== JSON.stringify(expected)) throw new Error(`${source}: renaming changed the routes (${check.join(", ")} ≠ ${expected.join(", ")})`);
  return { id, source, path: synthetic, text: renamed, routes };
}

/** `/api/v1/rooms.info` → prefix `/api/v1`, name `rooms.info`. */
function splitPrefix(template: string): { prefix: string; name: string } {
  const m = /^(\/api(?:\/v1|\/experimental)?)\/(.+)$/.exec(template);
  return m ? { prefix: m[1] as string, name: m[2] as string } : { prefix: "", name: template.replace(/^\//, "") };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Top-level statements of a file that are no imports or re-exports: realistic code to pad with. */
export function paddingStatements(text: string, path: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return sf.statements
    .filter((s) => !ts.isImportDeclaration(s) && !ts.isImportEqualsDeclaration(s) && !(ts.isExportDeclaration(s) && s.moduleSpecifier))
    .map((s) => s.getFullText(sf).replace(/^\s*\n/, "").trimEnd())
    .filter((s) => s.length > 0);
}

/** Splits a controller into its import block and its other top-level statements. */
function partsOf(text: string, path: string): { head: string; body: string[] } {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const head: string[] = [];
  const body: string[] = [];
  for (const s of sf.statements) {
    const piece = s.getFullText(sf).replace(/^\s*\n/, "").trimEnd();
    if (ts.isImportDeclaration(s) && body.length === 0) head.push(piece);
    else body.push(piece);
  }
  return { head: head.join("\n"), body };
}

/** Takes padding statements in a seeded order until `chars` characters are reached. */
function takePadding(pool: string[], chars: number, rng: () => number): string[] {
  const out: string[] = [];
  let size = 0;
  for (const s of shuffle(pool, rng)) {
    if (size >= chars) break;
    out.push(s);
    size += s.length + 2;
  }
  if (size < chars) throw new Error(`the padding pool holds ${size} characters, ${chars} needed`);
  return out;
}

function assemble(head: string, blocks: string[]): string {
  return `${[head, ...blocks].filter((b) => b.length > 0).join("\n\n")}\n`;
}

/**
 * The variants of one controller.
 * - Length series: the controller alone, then padded to each target size,
 *   padding placed so that every statement of the controller starts at the
 *   same relative place in the file as in the controller itself.
 * - Position series (when `positionChars` is set): the controller's
 *   statements kept together at the start, in the middle or at the end of a
 *   file of that size.
 */
export function variantsOf(c: Controller, pool: string[], levels: number[], positionChars: number | null, seed: number): Variant[] {
  const { head, body } = partsOf(c.text, c.path);
  const out: Variant[] = [];
  const make = (series: Variant["series"], level: string, text: string): Variant => {
    const lines = text.split("\n").length;
    const detected = detectRoutes(c.path, text);
    const routes = detected.map((r) => ({ ...r, position: Math.round(((r.line - 1) / Math.max(1, lines - 1)) * 1000) / 1000 }));
    const expected = c.routes.map((r) => `${r.method} ${r.prefix}/${r.renamed}`).sort();
    const got = routes.map((r) => `${r.method} ${r.template}`).sort();
    if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${c.id} ${series} ${level}: the variant declares ${got.join(", ")} instead of ${expected.join(", ")}`);
    return { id: `${c.id}-${series === "length" ? `L${level}` : `P-${level}`}`, controller: c.id, series, level, path: c.path, text, chars: text.length, routes };
  };
  out.push(make("length", "0", assemble(head, body)));
  const original = assemble(head, body);
  const offsets: number[] = [];
  let at = head.length > 0 ? head.length + 2 : 0;
  for (const b of body) {
    offsets.push(at / original.length);
    at += b.length + 2;
  }
  levels.forEach((chars, i) => {
    const rng = mulberry32(seedFrom(seed, c.id, "length", i));
    const padding = takePadding(pool, Math.max(0, chars - c.text.length), rng);
    const total = original.length + padding.reduce((n, x) => n + x.length + 2, 0);
    // padding goes before each statement until it starts where it started in the controller, relative to the length
    const blocks: string[] = [];
    let cursor = head.length > 0 ? head.length + 2 : 0;
    let next = 0;
    body.forEach((statement, k) => {
      const want = (offsets[k] ?? 0) * total;
      // add padding while it brings the statement closer to its place
      while (next < padding.length && Math.abs(cursor + (padding[next] as string).length + 2 - want) < Math.abs(cursor - want)) {
        blocks.push(padding[next] as string);
        cursor += (padding[next] as string).length + 2;
        next++;
      }
      blocks.push(statement);
      cursor += statement.length + 2;
    });
    blocks.push(...padding.slice(next));
    out.push(make("length", String(i + 1), assemble(head, blocks)));
  });
  if (positionChars !== null) {
    for (const place of ["start", "middle", "end"] as const) {
      const rng = mulberry32(seedFrom(seed, c.id, "position", place));
      const padding = takePadding(pool, Math.max(0, positionChars - c.text.length), rng);
      const half = Math.floor(padding.length / 2);
      const blocks = place === "start" ? [...body, ...padding] : place === "end" ? [...padding, ...body] : [...padding.slice(0, half), ...body, ...padding.slice(half)];
      out.push(make("position", place, assemble(head, blocks)));
    }
  }
  return out;
}

/**
 * Whether an extracted route list holds a variant's route: the same method
 * (or none given) and the same name, parameters compared by position. The
 * router prefix is not compared: a model that writes `/v1/x` or `x` for
 * `/api/v1/x` has found the declaration, and that habit does not change
 * with the length of the file.
 */
export function found(route: VariantRoute, extracted: Array<{ method: string | null; template: string }>): boolean {
  const bare = (t: string) => canonicalTargetKey(`http:GET:/${t.replace(/^\/+/, "").replace(/^(?:api\/)?(?:v1\/|experimental\/)?/, "")}@x`);
  const key = bare(route.template);
  return extracted.some((e) => {
    const method = (e.method ?? "*").toUpperCase();
    return (method === route.method || method === "*") && bare(e.template) === key;
  });
}
