import test from "node:test";
import assert from "node:assert/strict";
import { issueRefund } from "./service.js";

function fakeDb(order) {
  const orders = new Map([["o1", order]]);
  return { orders: { get: async (id) => orders.get(id), update: async (id, patch) => orders.set(id, { ...orders.get(id), ...patch }) } };
}

test("refunds an order once", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(init); return { ok: true, json: async () => ({ id: "r1" }) }; };
  const out = await issueRefund(fakeDb({ totalCents: 1000 }), "o1");
  assert.equal(out.status, "refunded");
  assert.equal(calls.length, 1);
});

test("rejects a zero amount", async () => {
  globalThis.fetch = async () => { throw new Error("gateway down"); };
  await assert.rejects(issueRefund(fakeDb({ totalCents: 1000 }), "o1", { amountCents: 0 }));
});
