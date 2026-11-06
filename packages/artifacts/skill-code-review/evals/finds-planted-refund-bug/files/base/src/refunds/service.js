import { refund } from "./gateway.js";

export async function issueRefund(db, orderId) {
  const order = await db.orders.get(orderId);
  if (!order) throw new Error("order not found");
  if (order.refundedAt) return { status: "already-refunded" };

  const key = `refund:${orderId}`;
  const result = await refund({ orderId, amountCents: order.totalCents, idempotencyKey: key });
  await db.orders.update(orderId, { refundedAt: new Date().toISOString(), refundId: result.id });
  return { status: "refunded", refundId: result.id };
}
