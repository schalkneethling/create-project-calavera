// @ts-check
import * as util from "node:util";

/**
 * @param {import("node:util").InspectColor | readonly import("node:util").InspectColor[]} format
 * @param {unknown} value
 * @returns {string}
 */
export function style(format, value) {
  const text = String(value);

  return typeof util.styleText === "function" ? util.styleText(format, text) : text;
}

/**
 * @param {import("node:util").InspectColor | readonly import("node:util").InspectColor[]} format
 * @param {unknown[]} values
 * @returns {string[]}
 */
export function styledValues(format, values) {
  return values.map((value) => style(format, value));
}

/**
 * @param {string} value
 * @returns {string}
 */
export function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function pluralizeCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A package.json script value as a single line of terminal output. JSON
 * quoting escapes quotes, backslashes, and C0 control characters; control and
 * format characters JSON leaves as they are, such as DEL, C1 controls, and
 * bidirectional overrides, and the line and paragraph separators, are escaped
 * as `\uXXXX` too, so a value cannot recolor, reorder, or break the line.
 * Nothing in the value is expanded.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function quoteScriptValue(value) {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) =>
    Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join(""),
  );
}
