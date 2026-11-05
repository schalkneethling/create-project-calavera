import test from "node:test";
import assert from "node:assert/strict";
import { issueRefund } from "./service.js";

function fakeDb(order) {
  const orders = new Map([["o1", order]]);
  return {
    orders: {
      get: async (id) => orders.get(id),
      update: async (id, patch) => orders.set(id, { ...orders.get(id), ...patch }),
    },
  };
}

test("refunds the full amount by default", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: "r1" }) });
  const out = await issueRefund(fakeDb({ totalCents: 1000 }), "o1");
  assert.equal(out.amountCents, 1000);
});

test("refunds a partial amount", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: "r2" }) });
  const out = await issueRefund(fakeDb({ totalCents: 1000 }), "o1", { amountCents: 250 });
  assert.equal(out.amountCents, 250);
});
