import { refund } from "./gateway.js";

// retries is true when a failed gateway call may be tried again.
export async function issueRefund(db, orderId, { amountCents, retries = false } = {}) {
  const order = await db.orders.get(orderId);
  if (!order) throw new Error("order not found");
  const amount = amountCents ?? order.totalCents;
  if (amount <= 0 || amount > order.totalCents - (order.refundedCents ?? 0)) {
    throw new Error("invalid refund amount");
  }

  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await refund({
        orderId,
        amountCents: amount,
        idempotencyKey: `refund:${orderId}:${attempt}`,
      });
      break;
    } catch (err) {
      if (!retries || attempt >= 2) throw err;
    }
  }

  await db.orders.update(orderId, {
    refundedCents: (order.refundedCents ?? 0) + amount,
    refundedAt: new Date().toISOString(),
    refundId: result.id,
  });
  return { status: "refunded", refundId: result.id, amountCents: amount };
}
