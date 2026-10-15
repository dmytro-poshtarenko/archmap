import type { InteractionType } from "../config/schema.js";

/** What a call site does with its target. */
export type Role = "request" | "publish" | "subscribe" | "access" | "schedule";

/**
 * Kinds of indirection followed to find an address. Any of them hides the
 * address from the call site, which is the evidence for case 3.
 */
export type HopKind = "const" | "import" | "reexport" | "wrapper" | "type" | "binding";

export interface Hop {
  kind: HopKind;
  /** `<repo>:<path>:<line>` of the declaration followed. */
  at: string;
  name?: string;
}

/** One piece of an address or a name. */
export type Part =
  | { k: "lit"; v: string }
  /** A parameter of the function containing the site; `path` reads a property of it. */
  | { k: "param"; fn: string; index: number; name: string; path: string[] }
  | { k: "env"; key: string }
  | { k: "setting"; key: string }
  /** Known only at run time, inside an otherwise known address (an id, a token). */
  | { k: "dyn"; why: string }
  | { k: "alts"; options: AbstractValue[] }
  /** Cannot be determined statically. */
  | { k: "unknown"; why: string };

/** The statically known shape of an address or a name, and how it was found. */
export interface AbstractValue {
  parts: Part[];
  hops: Hop[];
}

export interface CallSite {
  /** `<repo>:<path>:<line>:<column>` */
  id: string;
  repo: string;
  path: string;
  line: number;
  endLine: number;
  col: number;
  type: InteractionType;
  role: Role;
  /** `<pack>.<binding>` that recognised the call. */
  detector: string;
  /** HTTP method, when the type has one. */
  method: AbstractValue | null;
  address: AbstractValue;
  /** Components whose processes run this code. */
  components: string[];
  /** The call inside a wrapper this site was lifted from. */
  liftedFrom: string | null;
}

export type RouteKind = "http" | "ddp-method" | "broker-action" | "event" | "collection" | "timer";

export interface RouteDecl {
  /** `<repo>:<path>:<line>:<column>`, with `#n` when one declaration yields several routes. */
  id: string;
  kind: RouteKind;
  repo: string;
  path: string;
  line: number;
  col: number;
  method: string | null;
  /** Path template for HTTP, the name for the other kinds. */
  template: string;
  detector: string;
  source: "rules" | "llm" | "catalog";
  components: string[];
  extra: Record<string, unknown> | null;
}
