import { postJson } from "./http.js";
import { apiUrl } from "./urls.js";

export async function listOrders() {
  const response = await fetch(apiUrl("/orders"));
  return response.json();
}

export async function archiveOrder(id: string) {
  return postJson("/orders/archive", { id });
}
