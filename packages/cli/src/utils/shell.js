// @ts-check

/**
 * Quotes a token for display when a shell would otherwise split or expand it.
 *
 * @param {string} token
 * @returns {string}
 */
export function quoteShellToken(token) {
  return /^[\w@%+=:,./^~-]+$/.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}
