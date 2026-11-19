import { addToCart, checkout } from "../api/cart";

/** The cart screen: lists items and starts checkout. */
export function CartPage({ items }: { items: string[] }) {
  return (
    <div>
      {items.map((i) => (
        <span key={i}>{i}</span>
      ))}
      <button onClick={() => addToCart("sku-1")}>Add</button>
      <button onClick={() => checkout()}>Checkout</button>
    </div>
  );
}
