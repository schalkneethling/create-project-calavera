// @ts-check
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

/**
 * Where `offset` falls in `text`, as "line L, column C", both counted from 1.
 *
 * @param {string} text
 * @param {number} offset
 */
export function positionOf(text, offset) {
  const lines = text.slice(0, offset).split("\n");
  return `line ${lines.length}, column ${(lines.at(-1)?.length ?? 0) + 1}`;
}

/**
 * What is wrong with `text` as strict JSON, and where, such as "InvalidSymbol at line 3, column
 * 14", for text that `JSON.parse` rejected. It never holds text from `text`, unlike the message of
 * `JSON.parse`'s own error, which quotes the text around the error and so can carry a secret into
 * a log. When the strict JSON reading of `jsonc-parser` finds no error, it says so without a
 * position.
 *
 * @param {string} text
 */
export function jsonSyntaxProblem(text) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  parseJsonc(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  const [problem] = errors;
  return problem === undefined
    ? "a syntax error at an unknown position"
    : `${printParseErrorCode(problem.error)} at ${positionOf(text, problem.offset)}`;
}
