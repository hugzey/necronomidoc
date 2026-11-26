/** Order confirmation screen shown after a successful checkout. */
export function OrderPage({ orderId }: { orderId: string }) {
  return <h1>Order {orderId} confirmed</h1>;
}
