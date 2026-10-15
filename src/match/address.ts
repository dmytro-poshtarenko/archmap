import type { AbstractValue, Part } from "../core/types.js";

/** One path segment of the address a call site requests. */
export type SiteSegment =
  | { k: "lit"; text: string }
  /**
   * A whole segment known only at run time: an id or a token from a parameter
   * (`param`), a configuration value (`config`), or something not recoverable
   * statically (`unknown`).
   */
  | { k: "any"; from: "param" | "config" | "unknown" }
  /** Text glued to run-time pieces, e.g. `rooms.${kind}`. */
  | { k: "glob"; re: RegExp; text: string }
  /** An unknown tail: any number of segments. */
  | { k: "rest" };

/** Where an HTTP request goes, before the deployment is consulted. */
export type HostForm =
  /** A relative path: the same origin as the caller (the gateway, for a browser client). */
  | { k: "none" }
  | { k: "literal"; host: string }
  /** The base URL is read from an environment variable or a setting. */
  | { k: "env"; key: string }
  | { k: "setting"; key: string }
  /** Decided at run time, or not recoverable statically. */
  | { k: "unknown" };

export interface HttpAddress {
  host: HostForm;
  segments: SiteSegment[];
  /** Readable path with `:p` for run-time segments and `*` for unknown pieces. */
  text: string;
}

const SEG = "\u0001";
const ANY = "\u0002";
const CFG = "\u0003";

type Token = { k: "lit"; v: string } | { k: "hole"; part: Exclude<Part, { k: "lit" } | { k: "alts" }> };

/**
 * The HTTP address forms of a call's address: one per combination of
 * alternatives (at most `limit`), each split into a host and path segments.
 * The query string and the fragment never select a route and are dropped.
 */
export function httpForms(value: AbstractValue, limit = 32): { forms: HttpAddress[]; truncated: boolean } {
  const { lists, truncated } = expand(value.parts, limit);
  return { forms: lists.map(formOf), truncated };
}

/** Every combination of alternatives as a flat token list. */
function expand(parts: Part[], limit: number): { lists: Token[][]; truncated: boolean } {
  let lists: Token[][] = [[]];
  let truncated = false;
  for (const p of parts) {
    if (p.k === "alts") {
      const next: Token[][] = [];
      for (const option of p.options) {
        const inner = expand(option.parts, limit);
        truncated ||= inner.truncated;
        for (const head of lists) for (const tail of inner.lists) next.push([...head, ...tail]);
      }
      if (next.length > limit) truncated = true;
      lists = next.slice(0, limit);
    } else {
      const token: Token = p.k === "lit" ? { k: "lit", v: p.v } : { k: "hole", part: p };
      for (const list of lists) list.push(token);
    }
  }
  return { lists, truncated };
}

function formOf(tokens: Token[]): HttpAddress {
  const cut = withoutQuery(tokens);
  let host: HostForm = { k: "none" };
  let rest = cut;
  const first = cut[0];
  if (first?.k === "lit") {
    const scheme = /^([a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(first.v);
    if (scheme) {
      const after = first.v.slice(scheme[0].length);
      const hostText = scheme[2] ?? "";
      const hole = cut[1];
      if (after === "" && hole?.k === "hole") {
        // `http://${process.env.HOST}:3000/x`: the host itself is a value; `http://api.${domain}` is unknown
        const named = hostText === "" && (hole.part.k === "env" || hole.part.k === "setting");
        host = named && (hole.part.k === "env" || hole.part.k === "setting") ? { k: hole.part.k, key: hole.part.key } : { k: "unknown" };
        rest = dropHostTail(cut.slice(2));
      } else {
        host = { k: "literal", host: hostText.replace(/:\d+$/, "").replace(/^[^@]*@/, "").toLowerCase() };
        rest = after === "" ? cut.slice(1) : [{ k: "lit", v: after }, ...cut.slice(1)];
      }
    }
  } else if (first?.k === "hole") {
    const p = first.part;
    host = p.k === "env" || p.k === "setting" ? { k: p.k, key: p.key } : { k: "unknown" };
    rest = cut.slice(1);
  }
  const segments = segmentsOf(rest);
  return { host, segments, text: textOf(segments) };
}

/** Tokens up to the first `?` or `#`. */
function withoutQuery(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.k === "lit") {
      const at = t.v.search(/[?#]/);
      if (at !== -1) {
        if (at > 0) out.push({ k: "lit", v: t.v.slice(0, at) });
        return out;
      }
    }
    out.push(t);
  }
  return out;
}

/** After a host given by a value, skip `:port` up to the path. */
function dropHostTail(tokens: Token[]): Token[] {
  const first = tokens[0];
  if (first?.k !== "lit") return tokens;
  const at = first.v.indexOf("/");
  if (at === -1) return tokens.slice(1);
  return [{ k: "lit", v: first.v.slice(at) }, ...tokens.slice(1)];
}

function segmentsOf(tokens: Token[]): SiteSegment[] {
  let text = "";
  for (const t of tokens) {
    if (t.k === "lit") text += t.v;
    else text += t.part.k === "param" || t.part.k === "dyn" ? SEG : t.part.k === "env" || t.part.k === "setting" ? CFG : ANY;
  }
  if (text === "") return [];
  // empty segments (`/api//v1`) never select a different route
  const raw = text.split("/").filter((s) => s !== "");
  return raw.map((s, i): SiteSegment => {
    // a template written at the call site (`/v1/livechat/visitor/:token`, filled in by the client) names a parameter
    if (/^:\w+$/.test(s)) return { k: "any", from: "param" };
    if (!/[\u0001-\u0003]/.test(s)) return { k: "lit", text: s };
    if (s === SEG) return { k: "any", from: "param" };
    if (s === CFG) return { k: "any", from: "config" };
    if (s === ANY) return i === raw.length - 1 ? { k: "rest" } : { k: "any", from: "unknown" };
    const body = s
      .split(/([\u0001-\u0003])/)
      .map((piece) => (piece === SEG ? "[^/]+" : piece === ANY || piece === CFG ? "[^/]*" : escapeRe(piece)))
      .join("");
    return { k: "glob", re: new RegExp(`^${body}$`), text: s.replace(/[\u0001-\u0003]/g, "*") };
  });
}

function textOf(segments: SiteSegment[]): string {
  return `/${segments.map((s) => (s.k === "lit" ? s.text : s.k === "any" ? ":p" : s.k === "glob" ? s.text : "*")).join("/")}`;
}

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether every segment is literal, so the path is one concrete URL. */
export function isLiteralPath(segments: SiteSegment[]): boolean {
  return segments.every((s) => s.k === "lit");
}

/**
 * The method a site uses: upper-case verbs, or `null` when it is not known
 * statically (then any route method may match).
 */
export function methodsOf(value: AbstractValue | null): string[] | null {
  if (value === null) return null;
  const out = new Set<string>();
  const visit = (v: AbstractValue): boolean => {
    if (v.parts.length === 1 && v.parts[0]?.k === "lit") {
      out.add(v.parts[0].v.toUpperCase());
      return true;
    }
    if (v.parts.length === 1 && v.parts[0]?.k === "alts") return v.parts[0].options.every(visit);
    return false;
  };
  return visit(value) ? [...out].sort() : null;
}
