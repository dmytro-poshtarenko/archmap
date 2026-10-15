import { expressRoutes } from "./express.js";
import { rocketchatApi } from "./rocketchat-api.js";
import { rocketchatModels } from "./rocketchat-models.js";
import { rocketchatServices } from "./rocketchat-services.js";
import type { Detector } from "./types.js";

/** Code detectors by id, as packs name them. */
export const DETECTORS: Record<string, Detector> = {
  express: expressRoutes,
  "rocketchat-api": rocketchatApi,
  "rocketchat-services": rocketchatServices,
  "rocketchat-models": rocketchatModels,
};
