import { expressRoutes } from "./express.js";
import type { RouteDetector } from "./types.js";

/** Code detectors by id, as packs name them. */
export const DETECTORS: Record<string, RouteDetector> = {
  express: expressRoutes,
};
