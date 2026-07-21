const CSS_SPECIFICATION_HOSTS = new Set(["drafts.csswg.org"]);

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isCssSpecificationUrl(value) {
  try {
    return CSS_SPECIFICATION_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}
