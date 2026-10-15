import axios from "axios";

export async function getOrderItems(orderId: string) {
  const { data } = await axios.get(`/api/orders/${orderId}/items`);
  return data;
}

export async function searchOrders(term: string) {
  const { data } = await axios.get(`/api/orders/search?q=${encodeURIComponent(term)}`);
  return data;
}
