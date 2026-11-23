// @ts-check

/**
 * Runs `run` with an abort signal and holds it to a deadline counted from its start: the pattern
 * of the CLI version notice (ADR-0019 Decision 2), shared with the update check of
 * `artifacts status --check-updates` (#1138). At the deadline it aborts the signal with the error
 * `reason` returns, and the returned promise rejects with that error then, even if `run` ignores
 * the abort and never settles. Otherwise it settles as `run` does, and clears the deadline.
 *
 * @template T
 * @param {number} ms
 * @param {() => Error} reason
 * @param {(signal: AbortSignal) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withDeadline(ms, reason, run) {
  const controller = new AbortController();
  /** @type {Promise<never>} */
  const deadline = new Promise((_resolve, reject) => {
    // A signal aborts once, so the listener runs at most once.
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
  });
  const timer = setTimeout(() => controller.abort(reason()), ms);
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
