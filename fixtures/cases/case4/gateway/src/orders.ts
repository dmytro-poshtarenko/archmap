export async function fetchOrders() {
  const response = await fetch(`${process.env.ORDERS_URL}/orders`);
  return response.json();
}
