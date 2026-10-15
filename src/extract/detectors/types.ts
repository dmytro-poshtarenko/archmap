import type { ts } from "ts-morph";
import type { AbstractValue, RouteKind } from "../../core/types.js";
import type { Evaluator } from "../evaluate.js";
import type { Program, ProgramFile } from "../program.js";

export interface DetectorContext {
  program: Program;
  evaluator: Evaluator;
  files: ProgramFile[];
  /** Components running each file (`<repo>:<path>`), from the import graph. */
  usage?: Map<string, string[]>;
}

/** A route declaration found by a detector, before ids and components are assigned. */
export interface FoundRoute {
  node: ts.Node;
  kind: RouteKind;
  method: string | null;
  template: string;
  /** Components serving the route, when the code says so rather than the file's components. */
  components?: string[];
  extra?: Record<string, unknown>;
}

/** A code detector: a rule that bindings cannot express, versioned with the rules. */
export interface RouteDetector {
  kind: "routes";
  /** Bumped whenever the detector's output may change; part of the rules hash. */
  version: number;
  run(ctx: DetectorContext): FoundRoute[];
}

/** Builds a table that `lookup` value specs read, e.g. model interface → collection. */
export interface TableProvider {
  kind: "table";
  version: number;
  /** Name the specs use, e.g. `rocketchat.collections`. */
  table: string;
  build(ctx: DetectorContext): Map<string, AbstractValue>;
}

export type Detector = RouteDetector | TableProvider;
