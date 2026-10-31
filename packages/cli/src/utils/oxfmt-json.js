// @ts-check

// Writes JSON the way Oxfmt formats it with no configuration, so a file Calavera writes into a
// Vite+ project passes `vp fmt --check` and `vp staged` leaves it alone (#669). Oxfmt follows
// Prettier's JSON layout with Oxfmt's default print width of 100 (configuration_schema.json in the
// oxfmt package): two-space indentation, a non-empty object always
// expanded (because Calavera's own output puts its first key on a new line), and an array on one
// line when it fits. scripts/oxfmt-json.test.mjs checks the output against Oxfmt itself.

const PRINT_WIDTH = 100;
const INDENT = "  ";

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
    return JSON.stringify(value);
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
    return `${inner}${prefix}${print(member, inner, inner.length + prefix.length, suffix)}${suffix}`;
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
    if (!flat.includes("\n") && column + flat.length + suffix.length <= PRINT_WIDTH) return flat;
  }

  // Prettier fills an array of numbers: as many per line as fit, instead of one per line.
  if (value.every((item) => typeof item === "number")) {
    const rows = [];
    let row = "";
    for (const [index, item] of value.entries()) {
      const text = `${scalar(item)}${index < value.length - 1 ? "," : ""}`;
      if (row !== "" && inner.length + row.length + 1 + text.length > PRINT_WIDTH) {
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
