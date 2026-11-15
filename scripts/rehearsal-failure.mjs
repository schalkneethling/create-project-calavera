// What a failed rehearsal check reports (#918): what was expected, what happened, and the command
// that ran. Shared by scripts/rehearse-cli-experience.mjs and scripts/rehearsal-checks.mjs.

const OUTPUT_TAIL_LINES = 40;

/**
 * @typedef {{ exitCode: number | null, signal: string | null, timedOut: boolean, stdout: string, stderr: string, output: string, display: string }} CommandResult
 */

/** A failed assertion inside a check: what was expected, what happened, and the command that ran. */
export class CheckFailure extends Error {
  /** @param {{ expected: string, actual: string, command?: string }} details */
  constructor({ expected, actual, command }) {
    super(`Expected ${expected}; got ${actual}`);
    this.name = "CheckFailure";
    this.expected = expected;
    this.actual = actual;
    this.command = command;
  }
}

/** The last `count` lines of `text`, with a note when lines were left out. */
export function tail(text, count = OUTPUT_TAIL_LINES) {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= count) return lines.join("\n");
  return [`(${lines.length - count} earlier lines left out)`, ...lines.slice(-count)].join("\n");
}

/** @param {CommandResult} result */
export function describeExit(result) {
  if (result.timedOut) return `timed out and was stopped`;
  if (result.exitCode === null) return `ended by signal ${result.signal ?? "unknown"}`;
  return `exit code ${result.exitCode}`;
}
