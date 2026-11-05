// Thin client for the payment gateway. One call = one refund attempt.
export async function refund({ orderId, amountCents, idempotencyKey }) {
  const res = await fetch(`${process.env.GATEWAY_URL}/refunds`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ orderId, amountCents }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return res.json();
}
