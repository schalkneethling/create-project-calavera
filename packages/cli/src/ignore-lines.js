// @ts-check
// Stub for the failing-test-first step of #733. Replaced by the implementation.

/** @param {string} _line @returns {string | undefined} */
export function ignoreLineProblem(_line) {
  return undefined;
}

/**
 * @param {{ contents: string | undefined, declared: { integration: string, lines: string[] }[], records: { integration: string, lines: string[] }[] }} options
 */
export function planGitignoreBlocks({ contents }) {
  return {
    contents,
    changes: /** @type {object[]} */ ([]),
    records: /** @type {object[]} */ ([]),
  };
}
