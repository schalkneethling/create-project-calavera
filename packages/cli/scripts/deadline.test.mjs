// The deadline and abort the version notice (ADR-0019 Decision 2) and the update check of
// `artifacts status --check-updates` (#1138) share. The tests assert outcomes and the order of
// events, not wall-clock bounds, so a loaded machine does not make them fail.
import assert from "node:assert/strict";
import test from "node:test";

import { withDeadline } from "../src/utils/deadline.js";

test("a run that settles first keeps its value, and its signal is never aborted", async () => {
  /** @type {AbortSignal | undefined} */
  let seen;
  const value = await withDeadline(
    60_000,
    () => new Error("deadline"),
    async (signal) => {
      seen = signal;
      return "answered";
    },
  );

  assert.equal(value, "answered");
  assert.equal(seen?.aborted, false);
});

test("a run that fails first keeps its error", async () => {
  const failure = new Error("registry failed");
  await assert.rejects(
    withDeadline(
      60_000,
      () => new Error("deadline"),
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
});

test("at the deadline the signal is aborted and the promise rejects with the same error, though the run never settles", async () => {
  const reason = new Error("deadline");
  /** @type {AbortSignal | undefined} */
  let seen;
  await assert.rejects(
    withDeadline(
      10,
      () => reason,
      (signal) => {
        seen = signal;
        return new Promise(() => {});
      },
    ),
    (error) => error === reason,
  );

  assert.equal(seen?.aborted, true);
  assert.equal(seen?.reason, reason);
});

test("a run that ends on the abort is reported with the deadline's error, not its own", async () => {
  const reason = new Error("deadline");
  await assert.rejects(
    withDeadline(
      10,
      () => reason,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by the signal")));
        }),
    ),
    (error) => error === reason,
  );
});
