// @ts-check

// Writes JSON the way Oxfmt formats it with no configuration, so a file Calavera writes into a
// Vite+ project passes `vp fmt --check` and `vp staged` leaves it alone (#669). Oxfmt follows
// Prettier's JSON layout with Oxfmt's default print width of 100 (configuration_schema.json in the
// oxfmt package): two-space indentation, a non-empty object always
// expanded (because Calavera's own output puts its first key on a new line), and an array on one
// line when it fits. scripts/oxfmt-json.test.mjs checks the output against Oxfmt itself.

const PRINT_WIDTH = 100;
const INDENT = "  ";

// Oxfmt measures a line in display columns. A combining mark takes none; an East Asian wide or
// fullwidth character and an emoji take two. This covers the scripts and blocks that hold such
// characters (Han, Hiragana, Katakana apart from its halfwidth forms, Hangul syllables, CJK
// punctuation, fullwidth forms, and emoji presentation), not the whole Unicode width table.
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cc}\u200b-\u200f]/u;
const WIDE =
  /[\p{Script=Han}\p{Script=Hiragana}\u30a0-\u30ff\u31f0-\u31ff\uac00-\ud7a3\u3000-\u303f\uff01-\uff60\uffe0-\uffe6\p{Emoji_Presentation}]/u;

/**
 * @param {string} text
 * @returns {number}
 */
function displayWidth(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const character of text) {
    width += ZERO_WIDTH.test(character) ? 0 : WIDE.test(character) ? 2 : 1;
  }
  return width;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function scalar(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    // JSON.stringify writes 1e+21, and Oxfmt writes 1e21.
    return JSON.stringify(value).replace("e+", "e");
  }
  throw new Error(`${String(value)} cannot be written as JSON.`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the value prints across lines wherever it appears: a non-empty object always does, and
 * so does an array that holds one.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function alwaysBreaks(value) {
  if (isObject(value)) return Object.keys(value).length > 0;
  return Array.isArray(value) && value.some(alwaysBreaks);
}

/**
 * Prettier breaks an array of two or more arrays that each hold two or more items, even when it
 * would fit on one line.
 *
 * @param {unknown[]} items
 */
function isMatrix(items) {
  return items.length > 1 && items.every((item) => Array.isArray(item) && item.length > 1);
}

/**
 * @param {unknown} value
 * @param {string} indent The indentation of the line the value starts on.
 * @param {number} column Where the value starts on that line.
 * @param {string} suffix What follows the value on its line, such as a separating comma.
 * @returns {string}
 */
function print(value, indent, column, suffix) {
  if (Array.isArray(value)) return printArray(value, indent, column, suffix);
  if (isObject(value)) return printObject(value, indent);
  return scalar(value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} indent
 */
function printObject(value, indent) {
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const inner = indent + INDENT;
  const members = entries.map(([key, member], index) => {
    const prefix = `${JSON.stringify(key)}: `;
    const suffix = index < entries.length - 1 ? "," : "";
    return `${inner}${prefix}${print(member, inner, inner.length + displayWidth(prefix), suffix)}${suffix}`;
  });
  return `{\n${members.join("\n")}\n${indent}}`;
}

/**
 * @param {unknown[]} value
 * @param {string} indent
 * @param {number} column
 * @param {string} suffix
 */
function printArray(value, indent, column, suffix) {
  if (value.length === 0) return "[]";
  const inner = indent + INDENT;

  if (!value.some(alwaysBreaks) && !isMatrix(value)) {
    const flat = `[${value.map((item) => print(item, inner, 0, "")).join(", ")}]`;
    if (!flat.includes("\n") && column + displayWidth(flat) + suffix.length <= PRINT_WIDTH) {
      return flat;
    }
  }

  // Prettier fills an array of numbers: as many per line as fit, instead of one per line.
  if (value.every((item) => typeof item === "number")) {
    const rows = [];
    let row = "";
    for (const [index, item] of value.entries()) {
      const text = `${scalar(item)}${index < value.length - 1 ? "," : ""}`;
      if (row !== "" && inner.length + displayWidth(row) + 1 + text.length > PRINT_WIDTH) {
        rows.push(row);
        row = text;
      } else {
        row = row === "" ? text : `${row} ${text}`;
      }
    }
    rows.push(row);
    return `[\n${rows.map((text) => `${inner}${text}`).join("\n")}\n${indent}]`;
  }

  const items = value.map((item, index) => {
    const separator = index < value.length - 1 ? "," : "";
    return `${inner}${print(item, inner, inner.length, separator)}${separator}`;
  });
  return `[\n${items.join("\n")}\n${indent}]`;
}

/**
 * @param {unknown} value
 * @returns {string} The formatted JSON text, ending with a newline.
 */
export function formatJSON(value) {
  return `${print(value, "", 0, "")}\n`;
}

/**
 * Returns what rewriting `text` with formatJSON would lose, or undefined when the rewrite keeps
 * every value. JSON.parse keeps only the last of two equal keys in one object, and a number is
 * written in its shortest form, so 1.50 becomes 1.5 and a long integer loses precision. `text`
 * must already be valid JSON.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function rewriteLossProblem(text) {
  const token = /\s*(?:([{}[\],:])|("(?:[^"\\]|\\.)*")|(-?\d[\d.eE+-]*)|(true|false|null))/y;
  /** @type {(Set<string> | null)[]} One entry per open object (its keys) or array (null). */
  const open = [];
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
        return `holds the key ${string} more than once in one object, and only the last value would be kept`;
      }
      keys.add(key);
    } else if (number !== undefined) {
      const written = scalar(Number(number));
      if (written !== number) {
        return `holds the number ${number}, which Calavera would write as ${written}`;
      }
    }
  }
  return undefined;
}
