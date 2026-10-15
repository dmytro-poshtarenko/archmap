import axios from "axios";

// Order details come from the orders service; the legacy one serves only old invoices.
export async function getOrder(id: string) {
  const { data } = await axios.get(`/orders/${id}`);
  return data;
}
