import { match as compileMatch, type MatchFunction } from "path-to-regexp";
import { escapeRe, isLiteralPath, type SiteSegment } from "./address.js";

/** One segment of a declared route template. */
export type RouteSegment =
  | { k: "lit"; text: string }
  | { k: "param"; optional: boolean }
  /** Text and parameters in one segment, e.g. `:name.:ext`. */
  | { k: "mixed"; re: RegExp }
  | { k: "splat" };

export interface RoutePattern {
  segments: RouteSegment[];
  /** The template with every parameter written `:p`, for exact comparison. */
  canonical: string;
  /** path-to-regexp 8 matcher for concrete paths, when the template converts. */
  matcher: MatchFunction<object> | null;
}

/**
 * A route template (Express 4 or path-to-regexp 8 syntax) as segments.
 * Express forms are converted: `:id?` is an optional parameter, `*` and
 * `(.*)` a splat, `:id(\\d+)` a plain parameter.
 */
export function routePattern(template: string): RoutePattern {
  const path = `/${template.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const raw = path === "/" ? [] : path.slice(1).split("/");
  const segments = raw.map(routeSegment);
  const canonical = `/${segments.map((s, i) => (s.k === "lit" ? s.text : s.k === "splat" ? "*" : s.k === "param" ? ":p" : raw[i])).join("/")}`;
  let matcher: MatchFunction<object> | null = null;
  try {
    matcher = compileMatch(toPathToRegexp8(raw), { decode: false, end: true, trailing: true });
  } catch {
    matcher = null;
  }
  return { segments, canonical, matcher };
}

function routeSegment(seg: string): RouteSegment {
  const clean = seg.replace(/\((?:[^()\\]|\\.)*\)/g, (m) => (m === "(.*)" ? "*" : ""));
  if (clean === "*" || /^\*\w*$/.test(clean) || /^:\w+\*$/.test(clean)) return { k: "splat" };
  const param = /^:(\w+)(\?)?$/.exec(clean) ?? /^\{:(\w+)\}(\?)?$/.exec(clean);
  if (param) return { k: "param", optional: param[2] === "?" };
  if (!clean.includes(":") && !clean.includes("*")) return { k: "lit", text: clean };
  const body = clean
    .split(/(:\w+\??|\*)/)
    .map((piece) => (piece.startsWith(":") ? "[^/]+" : piece === "*" ? ".*" : escapeRe(piece)))
    .join("");
  return { k: "mixed", re: new RegExp(`^${body}$`) };
}

function toPathToRegexp8(raw: string[]): string {
  let out = "";
  let splats = 0;
  for (const seg of raw) {
    const s = routeSegment(seg);
    if (s.k === "lit") out += `/${s.text.replace(/[(){}*:?+!\\]/g, "\\$&")}`;
    else if (s.k === "param") out += s.optional ? `{/:p${out.length}}` : `/:p${out.length}`;
    else if (s.k === "splat") out += `/*s${splats++}`;
    else throw new Error("mixed segment");
  }
  return out === "" ? "/" : out;
}

/**
 * How well a site's path fits a route, best first when compared with
 * `compareScores`; `weak` marks fits that need a guess (a run-time segment
 * against a literal one, an unknown tail) or that only a route without any
 * literal segment gives (`/:path`, `/*`), and these never link on their own.
 */
export interface PathFit {
  exact: boolean;
  weak: boolean;
  score: [number, number, number, number];
}

/**
 * Fits a site path to a route: an exact match of the canonical forms, the
 * path-to-regexp 8 matcher for concrete paths, and a segment-by-segment
 * comparison when the site path has run-time parts.
 */
export function fitPath(site: SiteSegment[], siteText: string, route: RoutePattern): PathFit | null {
  const fit = fitAnyPath(site, siteText, route);
  // parameters and wildcards alone fit almost any address, so they cannot name the target
  const generic = route.segments.every((s) => s.k === "param" || s.k === "splat");
  return fit && generic ? { ...fit, weak: true } : fit;
}

function fitAnyPath(site: SiteSegment[], siteText: string, route: RoutePattern): PathFit | null {
  if (siteText === route.canonical && site.every((s) => s.k === "lit" || s.k === "any")) {
    const literal = route.segments.filter((s) => s.k === "lit").length;
    const params = route.segments.length - literal;
    return { exact: true, weak: false, score: [literal, 0, params, 0] };
  }
  if (isLiteralPath(site) && route.matcher) {
    const path = `/${site.map((s) => (s.k === "lit" ? s.text : "")).join("/")}`;
    if (!route.matcher(path)) return null;
    const literal = route.segments.filter((s) => s.k === "lit").length;
    const splats = route.segments.filter((s) => s.k === "splat").length;
    return { exact: false, weak: false, score: [literal, 0, 0, -splats] };
  }
  return fitSegments(site, route.segments);
}

function fitSegments(site: SiteSegment[], route: RouteSegment[]): PathFit | null {
  let best: PathFit | null = null;
  const consider = (fit: PathFit) => {
    if (best === null || compareScores(fit, best) < 0) best = fit;
  };
  const walk = (i: number, j: number, litlit: number, guesses: number, anyParam: number, splats: number, weak: boolean): void => {
    if (i === site.length && j === route.length) {
      consider({ exact: false, weak: weak || guesses > 0, score: [litlit, -guesses, anyParam, -splats] });
      return;
    }
    const s = site[i];
    const r = route[j];
    if (r?.k === "param" && r.optional) walk(i, j + 1, litlit, guesses, anyParam, splats, weak);
    if (r?.k === "splat") {
      walk(i, j + 1, litlit, guesses, anyParam, splats + 1, weak);
      if (s !== undefined) walk(i + 1, j, litlit, guesses, anyParam, splats, weak || s.k === "rest");
      return;
    }
    if (s?.k === "rest") {
      // an unknown tail covers the rest of the route
      consider({ exact: false, weak: true, score: [litlit, -guesses, anyParam, -splats] });
      return;
    }
    if (s === undefined || r === undefined) return;
    if (s.k === "lit") {
      if (r.k === "lit" && r.text === s.text) walk(i + 1, j + 1, litlit + 1, guesses, anyParam, splats, weak);
      else if (r.k === "param") walk(i + 1, j + 1, litlit, guesses, anyParam, splats, weak);
      else if (r.k === "mixed" && r.re.test(s.text)) walk(i + 1, j + 1, litlit, guesses, anyParam, splats, weak);
    } else if (s.k === "any") {
      if (r.k === "param") walk(i + 1, j + 1, litlit, guesses, anyParam + 1, splats, weak);
      else walk(i + 1, j + 1, litlit, guesses + 1, anyParam, splats, weak);
    } else if (s.k === "glob") {
      if (r.k === "param") walk(i + 1, j + 1, litlit, guesses, anyParam, splats, weak);
      else if (r.k === "lit" && s.re.test(r.text)) walk(i + 1, j + 1, litlit, guesses + 1, anyParam, splats, weak);
      else if (r.k === "mixed") walk(i + 1, j + 1, litlit, guesses + 1, anyParam, splats, weak);
    }
  };
  walk(0, 0, 0, 0, 0, 0, false);
  return best;
}

/** Negative when `a` fits better than `b`. */
export function compareScores(a: PathFit, b: PathFit): number {
  if (a.weak !== b.weak) return a.weak ? 1 : -1;
  for (let i = 0; i < a.score.length; i++) {
    const d = (b.score[i] ?? 0) - (a.score[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
