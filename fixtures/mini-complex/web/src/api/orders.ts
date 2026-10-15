import { http } from "./http.js";

export const listOrders = () => http.get("/orders");

export const createOrder = (order: { items: string[] }) => http.post("/orders", order);

export function getOrder(id: string) {
  return http.get(`/orders/${id}`);
}
