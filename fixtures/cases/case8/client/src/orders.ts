import { loadEndpoint } from "./settings.js";

export async function syncOrders() {
  const url = await loadEndpoint("orders-sync");
  return fetch(url, { method: "POST" });
}
