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
 * (https://toml.io/en/v1.0.0#keys). A basic string takes TOML 1.0's escapes, `\b`, `\t`, `\n`,
 * `\f`, `\r`, `\"`, `\\`, `\uXXXX`, and `\UXXXXXXXX`, and any character but the control
 * characters other than tab (https://toml.io/en/v1.0.0#string); a key with any other escape is
 * no header here.
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
    const decoded = basicString(basic);
    if (decoded === undefined) return undefined;
    keys.push(decoded);
  }
  return { keys, array: open === "[[" };
}

const ESCAPES = /** @type {Record<string, string>} */ ({
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
});

/**
 * The text a TOML basic string holds, from what stands between its quotes, or undefined when TOML
 * does not allow it.
 *
 * @param {string} body
 */
function basicString(body) {
  const escape = /\\(?:([btnfr"\\])|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8}))/g;
  // Every backslash starts one of the escapes, and no control character but tab appears.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(body)) return undefined;
  if (body.replace(escape, "").includes("\\")) return undefined;
  let scalar = true;
  const decoded = body.replace(escape, (_match, simple, short, long) => {
    if (simple !== undefined) return /** @type {string} */ (ESCAPES[simple]);
    const code = Number.parseInt(short ?? long, 16);
    // TOML allows only Unicode scalar values: no surrogate, nothing past U+10FFFF.
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      scalar = false;
      return "";
    }
    return String.fromCodePoint(code);
  });
  return scalar ? decoded : undefined;
}
