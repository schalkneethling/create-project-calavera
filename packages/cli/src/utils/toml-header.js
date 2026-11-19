// @ts-check

// Calavera reads TOML only to find a table in `.codex/config.toml`, so it has no TOML parser. This
// reads one line as a table header, which is all `eject` needs to tell where a table starts and
// which table it is (ADR-0017, Decision 2).

/**
 * The keys a TOML table header names, such as `["mcp_servers", "calavera"]` for
 * `[mcp_servers.calavera]`, `[ mcp_servers."calavera" ]`, or `[mcp_servers.calavera] # mine`, and
 * whether it is an array of tables (`[[...]]`). Undefined when the line is no header. Keys follow
 * the TOML 1.0 grammar: bare keys of ASCII letters, digits, `_`, and `-`, basic strings in double
 * quotes, and literal strings in single quotes, joined by dots with optional spaces
 * (https://toml.io/en/v1.0.0#keys). A basic string's escapes are read as JSON reads them, which
 * covers TOML's escapes except `\e` and `\xHH`; a key that uses either is no header here.
 *
 * @param {string} line A line without its line ending.
 * @returns {{ keys: string[], array: boolean } | undefined}
 */
export function tomlHeader(line) {
  const header = /^\s*(\[\[?)(.*?)(\]\]?)\s*(?:#.*)?$/.exec(line);
  if (!header) return undefined;
  // The pattern's three groups always take part in a match.
  const [open, text, close] = /** @type {string[]} */ (header.slice(1));
  if (open?.length !== close?.length) return undefined;
  const key = /\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(\.|$)/y;
  /** @type {string[]} */
  const keys = [];
  let dot = ".";
  // Each key is followed by a dot and another key, or ends the text.
  while (dot === ".") {
    const match = key.exec(/** @type {string} */ (text));
    if (!match) return undefined;
    const [, bare, basic, literal] = match;
    dot = /** @type {string} */ (match[4]);
    if (basic === undefined) {
      keys.push(/** @type {string} */ (bare ?? literal));
      continue;
    }
    try {
      keys.push(JSON.parse(`"${basic}"`));
    } catch {
      return undefined;
    }
  }
  return { keys, array: open === "[[" };
}
