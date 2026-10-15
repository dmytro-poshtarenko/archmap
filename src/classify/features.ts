import type { AbstractValue, CallSite, Part } from "../core/types.js";
import { httpForms } from "../match/address.js";
import { ALL_SOURCES, namesOf, type Resolution, type Resolver } from "../match/resolve.js";

/**
 * Features of a link, read from the full evidence whatever the variant:
 * - c1 the address is written at the call site;
 * - c2 it has substitutions, but the path or name is fully visible;
 * - c3 it is found only by following declarations (a wrapper, a constant, a proxy);
 * - c4 an environment variable or a setting is needed to choose the target part;
 * - c5 the address is known, but no rule declares a route that fits it;
 * - c6 several parts remain possible after the code and the infrastructure;
 * - c7 a gateway rule is needed;
 * - c8 part of the address is known only at run time.
 */
export interface Features {
  c1: boolean;
  c2: boolean;
  c3: boolean;
  c4: boolean;
  c5: boolean;
  c6: boolean;
  c7: boolean;
  c8: boolean;
}

export interface Classification {
  site: string;
  /** The highest case whose feature is present; null when the method finds no target in the system. */
  caseNo: number | null;
  features: Features;
  /** The resolution with every source, which the features were read from. */
  full: Resolution;
}

/**
 * Classifies a site the way the labelling guide does: by what is needed to
 * find its target. Whether the environment or a gateway rule is needed is
 * checked directly: the site is resolved again without that evidence, and
 * the evidence was needed if the answer changes.
 */
export function classifySite(resolver: Resolver, site: CallSite): Classification {
  const full = resolver.resolve(site, ALL_SOURCES);
  const linked = full.status === "linked";
  const changes = (r: Resolution) => r.status !== "linked" || r.target !== full.target;
  const c8 = undetermined(site);
  const c2 = site.type === "http" && substituted(site.address);
  const c3 = site.address.hops.length > 0 || site.liftedFrom !== null;
  const features: Features = {
    c1: !c2 && !c3 && !c8,
    c2,
    c3,
    c4: linked && changes(resolver.resolve(site, { ...ALL_SOURCES, env: false })),
    c5: !c8 && !full.ruleRoute && full.status !== "none",
    c6: full.status === "ambiguous",
    c7: linked && changes(resolver.resolve(site, { ...ALL_SOURCES, gateway: false })),
    c8,
  };
  return { site: site.id, caseNo: full.status === "none" ? null : caseOf(features), features, full };
}

/** The case of a set of features: the highest one present. */
export function caseOf(f: Features): number {
  const flags = [f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8];
  for (let i = flags.length - 1; i >= 0; i--) if (flags[i]) return i + 1;
  return 1;
}

/**
 * Whether part of the address is known only at run time: an unknown piece
 * of an HTTP address (its host, a segment, text glued to a value), or any
 * non-literal piece of a name (DDP method, action, event, collection, job).
 */
function undetermined(site: CallSite): boolean {
  if (site.type !== "http") return namesOf(site.address) === null;
  return httpForms(site.address).forms.some(
    (f) =>
      f.host.k === "unknown" ||
      f.segments.some((s) => s.k === "rest" || s.k === "glob" || (s.k === "any" && s.from === "unknown")) ||
      (f.segments.length === 0 && f.host.k !== "none" && f.host.k !== "literal"),
  );
}

function substituted(value: AbstractValue): boolean {
  const has = (p: Part): boolean => p.k === "param" || p.k === "dyn" || p.k === "env" || p.k === "setting" || (p.k === "alts" && p.options.some((o) => o.parts.some(has)));
  return value.parts.some(has);
}
