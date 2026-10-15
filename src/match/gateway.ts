import type { GatewayRule } from "../infra/model.js";
import type { SiteSegment } from "./address.js";

export interface GatewayPass {
  rule: GatewayRule;
  /** The path as the target container receives it. */
  segments: SiteSegment[];
}

/**
 * The rule a gateway applies to a request path: the matching rule with the
 * highest priority, as Traefik, nginx and ingress controllers decide, and
 * the path after its rewrite (`strip` removed, `replace` put in its place).
 * Run-time segments never match literal rule text. A rule bound to a host
 * applies to a request without a host of its own, since the caller's origin
 * is the public host.
 */
export function passGateway(rules: GatewayRule[], segments: SiteSegment[], host: string | null): GatewayPass | null {
  const { text, holes } = encode(segments);
  let best: GatewayRule | null = null;
  for (const r of rules) {
    if (r.host !== null && host !== null && r.host.toLowerCase() !== host) continue;
    if (!applies(r, text)) continue;
    if (best === null || r.priority > best.priority) best = r;
  }
  if (best === null) return null;
  let rewritten = text;
  if (best.strip !== null && rewritten.startsWith(best.strip)) rewritten = (best.replace ?? "") + rewritten.slice(best.strip.length);
  else if (best.replace !== null && best.strip === null) rewritten = best.replace + rewritten;
  if (!rewritten.startsWith("/")) rewritten = `/${rewritten}`;
  return { rule: best, segments: decode(rewritten.replace(/\/{2,}/g, "/"), holes) };
}

function applies(rule: GatewayRule, text: string): boolean {
  switch (rule.match) {
    case "exact":
      return text === rule.path;
    case "prefix":
      return text.startsWith(rule.path);
    case "regex":
      try {
        return new RegExp(rule.path).test(text.replace(/\u0000\d+\u0000/g, "x"));
      } catch {
        return false;
      }
  }
}

/** The path as text, each non-literal segment replaced by a numbered placeholder. */
function encode(segments: SiteSegment[]): { text: string; holes: SiteSegment[] } {
  const holes: SiteSegment[] = [];
  const parts = segments.map((s) => {
    if (s.k === "lit") return s.text;
    holes.push(s);
    return `\u0000${holes.length - 1}\u0000`;
  });
  return { text: `/${parts.join("/")}`, holes };
}

function decode(text: string, holes: SiteSegment[]): SiteSegment[] {
  const raw = text.replace(/^\/+/, "").split("/");
  if (raw.at(-1) === "") raw.pop();
  return raw.map((s): SiteSegment => {
    const m = /^\u0000(\d+)\u0000$/.exec(s);
    if (m) return holes[Number(m[1])] ?? { k: "any", from: "unknown" };
    return { k: "lit", text: s };
  });
}
