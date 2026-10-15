import type { ts } from "ts-morph";
import type { RouteKind } from "../../core/types.js";
import type { Evaluator } from "../evaluate.js";
import type { Program, ProgramFile } from "../program.js";

export interface DetectorContext {
  program: Program;
  evaluator: Evaluator;
  files: ProgramFile[];
}

/** A route declaration found by a detector, before ids and components are assigned. */
export interface FoundRoute {
  node: ts.Node;
  kind: RouteKind;
  method: string | null;
  template: string;
  extra?: Record<string, unknown>;
}

/** A code detector: a rule that bindings cannot express, versioned with the rules. */
export interface RouteDetector {
  kind: "routes";
  /** Bumped whenever the detector's output may change; part of the rules hash. */
  version: number;
  run(ctx: DetectorContext): FoundRoute[];
}
