// @ts-check
import { applyEdits, findNodeAtLocation, parseTree } from "jsonc-parser";

// Calavera changes one member of a person's JSON file, such as its `calavera` MCP entry, and keeps
// every other byte: indentation, line endings, a byte order mark, and key order (brief C8, #1221).
// jsonc-parser finds where the member is and applies the edit. Its `modify` is not used, because
// its formatting option reformats every line the edit touches, including a neighbor that ends on
// the same line, and without that option it writes the member on one line.

/** The byte order mark that can open a UTF-8 file, which `readFile` keeps as U+FEFF. */
const BOM = "﻿";

/**
 * `text` without its byte order mark, which JSON.parse rejects.
 *
 * @param {string} text
 */
export function withoutBom(text) {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * @typedef {{ path: string[], value: unknown }} JsonEdit A member to set to `value`, or to remove
 *   when `value` is undefined. A set adds missing objects on the way to the member.
 */

/**
 * One indentation level of `text`: the indentation of the outer object's first member when that
 * member opens an indented line, as it does in a file a formatter wrote. Any other text, such as
 * `{}` or JSON on one line, gets two spaces, as Calavera writes a new file.
 *
 * @param {string} text
 */
function indentUnitOf(text) {
  const first = parseTree(text)?.children?.[0];
  const indent =
    first !== undefined && startsLine(text, first.offset) ? indentAt(text, first.offset) : "";
  return indent || "  ";
}

/**
 * The line ending of the line `offset` is on, so an edit matches the lines around it even when a
 * stray line elsewhere ends differently. A line without an ending, such as JSON on one line, gets
 * LF.
 *
 * @param {string} text
 * @param {number} offset
 */
function eolAt(text, offset) {
  // Without a line feed after `offset`, the index is -2, which holds no character.
  return text[text.indexOf("\n", offset) - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * The whitespace that opens the line `offset` is on.
 *
 * @param {string} text
 * @param {number} offset
 */
function indentAt(text, offset) {
  const before = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
  // Within a line, JSON allows only spaces and tabs as whitespace.
  return before.slice(0, before.length - before.trimStart().length);
}

/**
 * Whether only whitespace comes before `offset` on its line.
 *
 * @param {string} text
 * @param {number} offset
 */
function startsLine(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return text.slice(lineStart, offset).trim() === "";
}

/**
 * `value` as JSON indented by `unit` and ending its lines with `eol`, for a value whose first line
 * sits on a line indented by `indent`.
 *
 * @param {unknown} value
 * @param {string} indent
 * @param {{ unit: string, eol: string }} style
 */
function render(value, indent, { unit, eol }) {
  return JSON.stringify(value, null, unit).replaceAll("\n", `${eol}${indent}`);
}

/**
 * @param {import("jsonc-parser").Node | undefined} node
 * @param {string[]} path
 * @returns {import("jsonc-parser").Node & { children: import("jsonc-parser").Node[] }}
 */
function objectNode(node, path) {
  if (node?.type !== "object" || node.children === undefined) {
    throw new Error(`The JSON at ${path.join(".") || "the root"} is not an object.`);
  }
  return /** @type {import("jsonc-parser").Node & { children: import("jsonc-parser").Node[] }} */ (
    node
  );
}

/**
 * @param {string} text
 * @param {string[]} path
 * @param {unknown} value
 * @param {string} unit One indentation level, from `indentUnitOf`.
 * @returns {import("jsonc-parser").Edit}
 */
function setEdit(text, path, value, unit) {
  const root = parseTree(text);
  const existing = findNodeAtLocation(/** @type {import("jsonc-parser").Node} */ (root), path);
  if (existing !== undefined) {
    return {
      offset: existing.offset,
      length: existing.length,
      content: render(value, indentAt(text, existing.offset), {
        unit,
        eol: eolAt(text, existing.offset),
      }),
    };
  }

  // Walk up to the deepest object that exists, wrapping the value in each one that does not.
  let depth = path.length - 1;
  let member = value;
  let parentNode = findNodeAtLocation(
    /** @type {import("jsonc-parser").Node} */ (root),
    path.slice(0, depth),
  );
  while (parentNode === undefined) {
    member = { [/** @type {string} */ (path[depth])]: member };
    depth -= 1;
    parentNode = findNodeAtLocation(
      /** @type {import("jsonc-parser").Node} */ (root),
      path.slice(0, depth),
    );
  }
  const parent = objectNode(parentNode, path.slice(0, depth));
  const key = JSON.stringify(path[depth]);
  const last = parent.children.at(-1);

  if (last === undefined) {
    // An empty object gets the member on its own line, and its closing brace on the next.
    const outer = indentAt(text, parent.offset);
    const inner = `${outer}${unit}`;
    const eol = eolAt(text, parent.offset);
    return {
      offset: parent.offset + 1,
      length: parent.length - 2,
      content: `${eol}${inner}${key}: ${render(member, inner, { unit, eol })}${eol}${outer}`,
    };
  }

  // After the last member, at its indentation when it opens its line.
  const indent = startsLine(text, last.offset)
    ? indentAt(text, last.offset)
    : `${indentAt(text, parent.offset)}${unit}`;
  const offset = last.offset + last.length;
  const eol = eolAt(text, offset);
  return {
    offset,
    length: 0,
    content: `,${eol}${indent}${key}: ${render(member, indent, { unit, eol })}`,
  };
}

/**
 * @param {string} text
 * @param {string[]} path
 * @returns {import("jsonc-parser").Edit | undefined}
 */
function removeEdit(text, path) {
  const node = findNodeAtLocation(
    /** @type {import("jsonc-parser").Node} */ (parseTree(text)),
    path,
  );
  const property = node?.parent;
  if (property === undefined) return undefined;
  // A property's parent is always an object.
  const parent = /** @type {import("jsonc-parser").Node} */ (property.parent);
  const members = /** @type {import("jsonc-parser").Node[]} */ (parent.children);
  const index = members.indexOf(property);
  const previous = members[index - 1];
  const next = members[index + 1];
  const end = property.offset + property.length;
  if (previous !== undefined) {
    // From the end of the member before it, so its comma goes with it.
    const start = previous.offset + previous.length;
    return { offset: start, length: end - start, content: "" };
  }
  if (next !== undefined) {
    // Up to the member after it, which then opens the line the removed member opened.
    return { offset: property.offset, length: next.offset - property.offset, content: "" };
  }
  // The only member: the object becomes empty.
  return { offset: parent.offset + 1, length: parent.length - 2, content: "" };
}

/**
 * Applies `edits` to the JSON object `text` in order, changing only the bytes of each member: a
 * new member follows the last one, in the file's indentation and the line ending of the line it
 * follows, and a removed member
 * takes its comma with it. Text outside the edited members, a byte order mark included, keeps its
 * bytes.
 *
 * @param {string} text JSON whose value is an object.
 * @param {JsonEdit[]} edits
 * @returns {string}
 */
export function editJson(text, edits) {
  const bom = text.startsWith(BOM) ? BOM : "";
  let body = withoutBom(text);
  const unit = indentUnitOf(body);
  for (const { path, value } of edits) {
    const edit = value === undefined ? removeEdit(body, path) : setEdit(body, path, value, unit);
    if (edit !== undefined) body = applyEdits(body, [edit]);
  }
  return `${bom}${body}`;
}
