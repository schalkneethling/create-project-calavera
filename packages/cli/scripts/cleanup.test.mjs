// Issue #988: the temporary folders apply rebuilds and stages artifacts in are each removed, even
// when removing another fails, and a failed removal never hides the failure that stopped apply.
import assert from "node:assert/strict";
import test from "node:test";

import { CleanupError, errorAfterCleanups, runCleanups } from "../src/utils/cleanup.js";

test("runCleanups runs every cleanup when an earlier one fails, and lists each failure once", async () => {
  const busy = new Error("EBUSY: resource busy");
  const denied = new Error("EACCES: permission denied");
  let laterRan = false;

  await assert.rejects(
    runCleanups([
      () => Promise.reject(busy),
      // A nested cleanup's failures join the outer list instead of nesting.
      () => runCleanups([() => Promise.reject(denied)]),
      async () => {
        laterRan = true;
      },
    ]),
    (/** @type {unknown} */ error) => {
      assert.ok(error instanceof CleanupError);
      assert.deepEqual(error.errors, [busy, denied]);
      assert.match(error.message, /EBUSY: resource busy EACCES: permission denied/);
      return true;
    },
  );
  assert.equal(laterRan, true);
});

test("runCleanups resolves when every cleanup succeeds", async () => {
  await runCleanups([async () => {}, async () => {}]);
});

test("errorAfterCleanups returns the original error itself when every cleanup succeeds", async () => {
  const stopped = new Error("formatter failed");
  let ran = false;

  const result = await errorAfterCleanups(stopped, [
    async () => {
      ran = true;
    },
  ]);

  assert.equal(result, stopped);
  assert.equal(ran, true);
});

test("errorAfterCleanups keeps the original error first and as the cause when a cleanup fails", async () => {
  const stopped = new Error("formatter failed");
  const busy = new Error("EBUSY: resource busy");
  let laterRan = false;

  const result = await errorAfterCleanups(stopped, [
    () => Promise.reject(busy),
    async () => {
      laterRan = true;
    },
  ]);

  assert.ok(result instanceof AggregateError);
  assert.deepEqual(result.errors, [stopped, busy]);
  assert.equal(result.cause, stopped);
  assert.match(
    result.message,
    /^formatter failed Removing Calavera's temporary folders also failed: EBUSY: resource busy$/,
  );
  assert.equal(laterRan, true);
});
