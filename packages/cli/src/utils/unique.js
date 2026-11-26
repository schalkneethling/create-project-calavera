// @ts-check
import { isNotEmptyString } from "./guards.js";

/**
 * The non-empty strings of `values`, each once, in the order they first appear.
 *
 * @param {Array<string | null | undefined | false>} values
 * @returns {string[]}
 */
export function unique(values) {
  return [...new Set(values.filter(isNotEmptyString))];
}
