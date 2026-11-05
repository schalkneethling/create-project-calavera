import test from "node:test";
import assert from "node:assert/strict";
import { issueRefund } from "./service.js";

test("refunds an order once", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init);
    return { ok: true, json: async () => ({ id: "r1" }) };
  };
  const orders = new Map([["o1", { totalCents: 1000 }]]);
  const db = {
    orders: {
      get: async (id) => orders.get(id),
      update: async (id, patch) => orders.set(id, { ...orders.get(id), ...patch }),
    },
  };
  assert.deepEqual(await issueRefund(db, "o1"), { status: "refunded", refundId: "r1" });
  assert.equal(calls.length, 1);
});
