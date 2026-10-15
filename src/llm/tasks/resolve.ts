import { z } from "zod";
import type { TargetConfig } from "../../config/schema.js";
import { canonicalTargetKey } from "../../core/keys.js";
import type { CallSite, RouteDecl } from "../../core/types.js";
import type { InfraFacts } from "../../infra/model.js";
import { httpForms } from "../../match/address.js";
import { evaluateGuard, type GuardSwitch } from "../../match/guards.js";
import { namesOf, type Resolver, type Sources } from "../../match/resolve.js";
import { fitPath } from "../../match/routes.js";
import { loadTemplate, render, TEMPLATES } from "../prompts.js";
import type { LlmRequest } from "../types.js";
import { numbered } from "./extractRoutes.js";

export const SelectAnswer = z.object({
  /** `C1`…`C5`, or `NONE`. */
  choice: z.string(),
  confidence: z.number().min(0).max(1),
});
export type SelectAnswer = z.infer<typeof SelectAnswer>;

export const FreeAnswer = z.object({
  target: z
    .object({
      kind: z.enum(["http", "ddp-call", "ddp-sub", "action", "event", "collection", "timer"]),
      method: z.string().nullable(),
      name: z.string(),
      component: z.string(),
    })
    .nullable(),
  confidence: z.number().min(0).max(1),
});
export type FreeAnswer = z.infer<typeof FreeAnswer>;

const MAX_TOKENS = { select: 4000, free: 6000 };

/**
 * What the model is told about the system, from what the variant may use:
 * the parts of the config always; with the infrastructure, the containers
 * and the gateway rules; with the rules, where each broker service runs and
 * the collections the code uses.
 */
export function systemDescription(input: {
  config: TargetConfig;
  infra: InfraFacts;
  routes: RouteDecl[];
  sites: CallSite[];
  sources: Sources;
  guards: GuardSwitch[];
}): string {
  const { config, infra, sources } = input;
  const out: string[] = ["Parts of the system:"];
  for (const c of config.components) {
    const containers = sources.env ? infra.containers.filter((x) => x.component === c.id) : [];
    const hosts = [...new Set(containers.flatMap((x) => x.hostnames.map((h) => (x.ports[0] ? `${h}:${x.ports[0]}` : h))))];
    out.push(`- ${c.id} (${c.kind})${hosts.length > 0 ? `, reachable as ${hosts.join(", ")}` : ""}`);
  }
  if (sources.gateway && infra.rules.length > 0) {
    out.push("", "Gateway rules (requests from browser clients pass the gateway):");
    for (const r of [...infra.rules].sort((a, b) => b.priority - a.priority)) {
      const target = infra.containers.find((c) => c.name === r.target || c.hostnames.includes(r.target))?.component ?? r.target;
      out.push(`- ${r.gateway}: ${r.match} ${r.path}${r.host ? ` on host ${r.host}` : ""} → ${target}${r.strip ? ` (strips ${r.strip})` : ""}`);
    }
  }
  if (sources.rules) {
    const placement = new Map<string, Set<string>>();
    for (const r of input.routes.filter((x) => x.kind === "broker-action")) {
      const service = r.template.split(".")[0] ?? r.template;
      const regs = Array.isArray(r.extra?.registrations) ? (r.extra.registrations as Array<{ components: string[]; guard: string }>) : [];
      const parts = placement.get(service) ?? new Set<string>();
      for (const reg of regs) {
        for (const c of reg.components) {
          const env = sources.env ? { ...config.infra.env, ...(infra.containers.find((x) => x.component === c)?.env ?? {}) } : null;
          const deployed = !sources.env || infra.containers.length === 0 || infra.containers.some((x) => x.component === c);
          if (deployed && evaluateGuard(reg.guard, env, input.guards) !== false) parts.add(c);
        }
      }
      if (regs.length === 0) for (const c of r.components) parts.add(c);
      placement.set(service, parts);
    }
    if (placement.size > 0) {
      out.push("", "Broker services and the parts they run in:");
      for (const [service, parts] of [...placement].sort(([a], [b]) => a.localeCompare(b))) out.push(`- ${service}: ${[...parts].sort().join(", ") || "not deployed"}`);
    }
    const collections = new Set<string>();
    for (const s of input.sites.filter((x) => x.type === "db")) for (const n of namesOf(s.address) ?? []) collections.add(n);
    if (collections.size > 0) out.push("", `MongoDB collections: ${[...collections].sort().join(", ")}`);
  }
  return out.join("\n");
}

/**
 * The code around a call: the file's import block, then `contextLines` lines
 * on each side with line numbers, the call's first line marked `>>`.
 */
export function fragmentOf(text: string, site: Pick<CallSite, "line" | "endLine">, contextLines: number): string {
  const lines = text.split("\n");
  const from = Math.max(1, site.line - contextLines);
  const to = Math.min(lines.length, Math.max(site.endLine, site.line) + contextLines);
  const imports: number[] = [];
  for (let i = 0; i < Math.min(lines.length, from - 1); i++) {
    if (/^\s*(import|export\s+\*?\s*\{?.*\bfrom\b|const\s+\w+\s*=\s*require\()/.test(lines[i] ?? "")) imports.push(i + 1);
  }
  const mark = (block: string) =>
    block
      .split("\n")
      .map((l) => (new RegExp(`^\\s*${site.line}\\|`).test(l) ? `>> ${l}` : `   ${l}`))
      .join("\n");
  const parts: string[] = [];
  if (imports.length > 0) parts.push(imports.map((n) => `   ${numbered([lines[n - 1] ?? ""], n)}`).join("\n"), "   …");
  parts.push(mark(numbered(lines.slice(from - 1, to), from)));
  return parts.join("\n");
}

export function selectRequest(o: { project: string; system: string; path: string; code: string; candidates: string[]; subject: string; effort: LlmRequest["effort"]; repeat?: number }): LlmRequest<SelectAnswer> {
  const t = loadTemplate(TEMPLATES.select);
  return {
    task: "resolve-select",
    template: TEMPLATES.select,
    subject: o.subject,
    system: render(t.system, { project: o.project, system: o.system }),
    user: render(t.user, { path: o.path, code: o.code, candidates: [...o.candidates.map((c, i) => `C${i + 1}: ${c}`), "NONE: none of these"].join("\n") }),
    schema: SelectAnswer,
    maxTokens: MAX_TOKENS.select,
    effort: o.effort,
    repeat: o.repeat ?? 0,
  };
}

export function freeRequest(o: { project: string; system: string; path: string; code: string; subject: string; effort: LlmRequest["effort"]; repeat?: number }): LlmRequest<FreeAnswer> {
  const t = loadTemplate(TEMPLATES.free);
  return {
    task: "resolve-free",
    template: TEMPLATES.free,
    subject: o.subject,
    system: render(t.system, { project: o.project, system: o.system }),
    user: render(t.user, { path: o.path, code: o.code }),
    schema: FreeAnswer,
    maxTokens: MAX_TOKENS.free,
    effort: o.effort,
    repeat: o.repeat ?? 0,
  };
}

/** The candidate a select answer names, or null for NONE and for answers naming no listed candidate. */
export function chosen(answer: SelectAnswer | null, candidates: string[]): string | null {
  const m = answer ? /^C(\d+)$/i.exec(answer.choice.trim()) : null;
  return m ? (candidates[Number(m[1]) - 1] ?? null) : null;
}

/**
 * Turns a free answer into a key of the method's catalog. The part is
 * matched by id, alias or container host name; an HTTP route is found by
 * fitting the named path to the templates of that part, so a concrete path
 * finds its template. A key the catalog does not hold makes no link and is
 * reported as invented.
 */
export function normaliseFree(
  answer: FreeAnswer | null,
  ctx: { resolver: Resolver; catalog: Map<string, string>; partOf: (name: string) => string | null; sources: Sources },
): { key: string | null; proposed: string | null; invented: boolean } {
  const t = answer?.target;
  if (!t) return { key: null, proposed: null, invented: false };
  const part = ctx.partOf(t.component);
  const component = part ?? t.component.trim();
  let proposed: string;
  switch (t.kind) {
    case "http": {
      const method = (t.method ?? "*").toUpperCase();
      const path = `/${t.name.trim().replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\/+/, "").replace(/\/+$/, "")}`;
      proposed = `http:${method}:${path}@${component}`;
      const form = httpForms({ parts: [{ k: "lit", v: path }], hops: [] }).forms[0];
      if (form) {
        const fits = ctx.resolver
          .routesOf("http", { ...ctx.sources, rules: true })
          .filter((r) => r.components.includes(component) && (r.method === null || method === "*" || r.method.toUpperCase() === method))
          .map((r) => ({ r, fit: fitPath(form.segments, form.text, ctx.resolver.patternOf(r.template)) }))
          .filter((x) => x.fit !== null && !x.fit.weak)
          .sort((a, b) => (b.fit?.score[0] ?? 0) - (a.fit?.score[0] ?? 0));
        const best = fits[0]?.r;
        if (best) return { key: `http:${best.method?.toUpperCase() ?? method}:${best.template}@${component}`, proposed, invented: false };
      }
      break;
    }
    case "ddp-call":
    case "ddp-sub":
      proposed = `ddp:${t.kind === "ddp-sub" ? "sub" : "call"}:${t.name.trim()}@${component}`;
      break;
    case "action":
      proposed = `action:-:${t.name.trim()}@${component}`;
      break;
    case "event":
      proposed = `event:-:${t.name.trim()}@*`;
      break;
    case "collection":
      proposed = `coll:-:${t.name.trim()}@${component}`;
      break;
    case "timer":
      proposed = `timer:-:${t.name.trim()}@${component}`;
      break;
  }
  const key = ctx.catalog.get(canonicalTargetKey(proposed)) ?? null;
  return { key, proposed, invented: key === null };
}

/**
 * Every target key the method knows under a variant, by canonical form:
 * declared routes in their parts; with the rules, also the events and
 * collections the code names and the timers in the parts registering them.
 */
export function methodCatalog(resolver: Resolver, sites: CallSite[], sources: Sources): Map<string, string> {
  const keys: string[] = [];
  for (const r of resolver.routesOf("http", sources)) for (const c of r.components) keys.push(`http:${r.method?.toUpperCase() ?? "*"}:${r.template}@${c}`);
  for (const r of resolver.routesOf("ddp-method", sources)) for (const c of r.components) keys.push(`ddp:${r.method === "sub" ? "sub" : "call"}:${r.template}@${c}`);
  for (const r of resolver.routesOf("broker-action", sources)) for (const c of r.components) keys.push(`action:-:${r.template}@${c}`);
  // events, collections and jobs are known from the rules' reading of the call sites
  if (sources.rules) {
    for (const n of resolver.knownEvents()) keys.push(`event:-:${n}@*`);
    for (const n of resolver.knownNames("db")) for (const d of resolver.databases()) keys.push(`coll:-:${n}@${d}`);
    for (const s of sites.filter((x) => x.type === "trigger")) for (const n of namesOf(s.address) ?? []) for (const c of s.components) keys.push(`timer:-:${n}@${c}`);
  }
  return new Map(keys.map((k) => [canonicalTargetKey(k), k]));
}
