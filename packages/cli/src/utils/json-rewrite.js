// @ts-check
import { isDeepStrictEqual } from "node:util";

/** The remedy for formatted text that does not hold what Calavera sent. */
export const PRINTS_NOTHING =
  "Make sure vite.config.ts prints nothing when vp fmt loads it, then run Calavera again.";

// Calavera rewrites a whole JSON file when it changes part of it, such as the hook groups in
// .claude/settings.json. The text it writes comes from the project's formatter (see
// project-formatter.js), and a rewrite that would lose something the person wrote is reported
// before anything is written.

/**
 * @typedef {import("./project-formatter.js").ProjectFormatter} ProjectFormatter
 */

/**
 * JSON.stringify drops an undefined property and writes a non-finite number as null. Calavera
 * refuses both instead, so a value never changes silently on its way into a file.
 *
 * @param {string} _key
 * @param {unknown} value
 */
function strict(_key, value) {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error(`${String(value)} cannot be written as JSON.`);
  }
  return value;
}

/**
 * Writes `value` as JSON with two-space indentation, before any formatting. Every object starts
 * its first key on a new line, which is what tells Oxfmt to keep it expanded.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function toJSONText(value) {
  return JSON.stringify(value, strict, 2);
}

/**
 * Returns the text Calavera writes for `value` as the file at `path`: the JSON, formatted by the
 * project's formatter. Nothing is written, so the dry run can show exactly this text.
 *
 * @param {unknown} value
 * @param {string} path The file path relative to the project root, such as .claude/settings.json.
 * @param {ProjectFormatter} formatter
 * @returns {Promise<string>}
 * @throws When the formatted text does not parse back to `value`.
 */
export async function writeJSON(value, path, formatter) {
  const json = toJSONText(value);
  const text = await formatter.format(path, `${json}\n`);
  // The formatter runs the project's vite.config.ts, and anything that file prints, such as a
  // dotenv banner, arrives before the formatted text. Text that no longer holds the values goes
  // nowhere near the file.
  // #1157: neither error quotes the text, because it can hold the file's values or whatever
  // vite.config.ts printed.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${formatter.description} returned text for ${path} that is not JSON, so something came with the formatted text, such as output that vite.config.ts printed. ${PRINTS_NOTHING}`,
    );
  }
  // Compared with the JSON Calavera sent, not with `value`: JSON has no -0, so -0 arrives as 0.
  if (!isDeepStrictEqual(parsed, JSON.parse(json))) {
    throw new Error(
      `${formatter.description} returned text for ${path} that is JSON but holds other values than the ones Calavera sent. ${PRINTS_NOTHING}`,
    );
  }
  return text;
}

/**
 * Returns what a rewrite of `text` would lose, or undefined when it loses nothing. JSON.parse keeps
 * only the last of two equal keys in one object, and a number comes back in the spelling Calavera
 * writes, which can differ from the person's (1.50 becomes 1.5) or lose digits past what a double
 * holds. `text` must already parse as JSON.
 *
 * @param {string} text
 * @param {string} path The file path relative to the project root, which picks the formatter's language.
 * @param {ProjectFormatter} formatter
 * @param {{ withoutValues?: boolean }} [options] `withoutValues` names the line of a number instead
 *   of the number, for a file that can hold tokens, such as an MCP harness file `eject` reports on
 *   or a recipe `artifacts migrate` rewrites. A repeated key is named either way, and with
 *   `withoutValues` its line too, so the person can find it (#1078). Apply's messages for Claude
 *   Code settings keep naming the number.
 * @returns {Promise<string | undefined>}
 */
export async function rewriteLossProblem(text, path, formatter, { withoutValues = false } = {}) {
  const token = /\s*(?:([{}[\],:])|("(?:[^"\\]|\\.)*")|(-?\d[\d.eE+-]*)|(true|false|null))/y;
  /** @type {(Set<string> | null)[]} One entry per open object (its keys) or array (null). */
  const open = [];
  /** @type {string[]} */
  const numbers = [];
  /** @type {number[]} The line of each number, counted from 1. */
  const lines = [];
  /** @param {RegExpExecArray} match @param {string} matched The matched number or key. */
  const lineOf = (match, matched) =>
    text.slice(0, match.index + match[0].length - matched.length).split("\n").length;
  let expectKey = false;
  for (let match = token.exec(text); match !== null; match = token.exec(text)) {
    const [, punctuation, string, number] = match;
    if (punctuation === "{") {
      open.push(new Set());
      expectKey = true;
    } else if (punctuation === "[") {
      open.push(null);
    } else if (punctuation === "}" || punctuation === "]") {
      open.pop();
    } else if (punctuation === ",") {
      expectKey = open.at(-1) instanceof Set;
    } else if (punctuation === ":") {
      expectKey = false;
    } else if (string !== undefined && expectKey) {
      const key = JSON.parse(string);
      const keys = /** @type {Set<string>} */ (open.at(-1));
      if (keys.has(key)) {
        // A line number exposes no value, so every caller names it.
        return `holds the key ${string} more than once in one object, again on line ${lineOf(match, string)}, and only the last value would be kept`;
      }
      keys.add(key);
    } else if (number !== undefined) {
      if (!Number.isFinite(Number(number))) {
        return withoutValues
          ? `holds a number on line ${lineOf(match, number)} that is too large for Calavera to write`
          : `holds the number ${number}, which is too large for Calavera to write`;
      }
      numbers.push(number);
      // Only callers that pass withoutValues (eject and artifacts migrate) name a number's line,
      // so apply skips the extra scan.
      if (withoutValues) lines.push(lineOf(match, number));
    }
  }
  if (numbers.length === 0) return undefined;

  // The formatter decides the spelling: Oxfmt writes 1e21 where JSON.stringify writes 1e+21. All
  // the numbers go through it at once, as one array formatted as this file, so the project's
  // settings and ignore patterns for the file apply.
  const written = (await writeJSON(numbers.map(Number), path, formatter)).match(/-?\d[\d.eE+-]*/g);
  if (written?.length !== numbers.length) {
    throw new Error(
      `Calavera could not read back the numbers it formatted for ${path}: it sent ${numbers.length} and got ${written?.length ?? 0}.`,
    );
  }
  for (const [index, number] of numbers.entries()) {
    if (written[index] !== number) {
      return withoutValues
        ? `holds a number on line ${lines[index]} that Calavera would write in another spelling`
        : `holds the number ${number}, which Calavera would write as ${written[index]}`;
    }
  }
  return undefined;
}
