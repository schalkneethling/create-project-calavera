// @ts-check
import { styleText } from "node:util";

/**
 * @param {import("node:util").InspectColor | readonly import("node:util").InspectColor[]} format
 * @param {unknown} value
 * @returns {string}
 */
export function style(format, value) {
  return styleText(format, String(value));
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
