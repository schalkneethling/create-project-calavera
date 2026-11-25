// @ts-check
// The layout the human-readable summaries share (#601, #617, #331): a headline, then labeled
// groups separated by blank lines, with each item indented under its heading and its details
// indented under the item. The `--json` and MCP results do not use these lines.

/** @typedef {{ level: "info" | "success" | "warn", text: string }} SummaryLine */

export const ITEM = "  ";
export const DETAIL = "    ";

/**
 * Adds a blank line, the heading, and the items, or nothing when there are no items.
 *
 * @param {SummaryLine[]} lines
 * @param {string} heading
 * @param {SummaryLine[]} items
 */
export function pushGroup(lines, heading, items) {
  if (items.length === 0) return;
  lines.push(info(""), info(`${heading}:`), ...items);
}

/** @param {string} text @returns {SummaryLine} */
export function info(text) {
  return { level: "info", text };
}

/** @param {string} text @returns {SummaryLine} */
export function warn(text) {
  return { level: "warn", text };
}

/**
 * The present tense of a dry run or the past tense of a completed command.
 *
 * @param {boolean} dryRun
 * @param {string} planned Such as "Would write".
 * @param {string} done Such as "Wrote".
 */
export function tense(dryRun, planned, done) {
  return dryRun ? planned : done;
}
