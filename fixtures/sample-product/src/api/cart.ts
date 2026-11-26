/** Add one item to the shopper's cart. */
export async function addToCart(sku: string): Promise<void> {
  await fetch("/cart/items", { method: "POST", body: JSON.stringify({ sku }) });
}

/** Pay for the cart and create an order; resolves to the order id. */
export async function checkout(): Promise<string> {
  const res = await fetch("/checkout", { method: "POST" });
  return ((await res.json()) as { id: string }).id;
}
