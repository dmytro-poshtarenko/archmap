import axios from "axios";

export async function listOrders() {
  const response = await axios.get("/api/orders");
  return response.data;
}
