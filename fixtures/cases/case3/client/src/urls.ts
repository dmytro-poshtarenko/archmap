import { API_BASE } from "./config.js";

export const apiUrl = (path: string) => `${API_BASE}${path}`;
