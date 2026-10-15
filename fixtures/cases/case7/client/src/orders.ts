export async function listOrders() {
  const response = await fetch("/shop/orders");
  return response.json();
}
