// @ts-check
import { readFile } from "node:fs/promises";

/**
 * Makes a key or variable name safe to print: a project file controls its content, so it must not
 * carry terminal escape sequences or flood a message.
 * @param {string} text
 */
export function printable(text) {
  const clean = text.replace(/\p{Cc}/gu, "");
  return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean;
}

/** @param {unknown} error */
export function errorCode(error) {
  return /** @type {NodeJS.ErrnoException} */ (error).code ?? "unknown error";
}

/**
 * Reads a configuration file, or returns undefined when it is missing or unreadable. Like npm,
 * Yarn, and Bun, the caller continues without an unreadable file. The warning names the path and
 * error code only, never the contents.
 * @param {string} path
 * @param {string} kind Such as "npm configuration file".
 * @param {string[]} warnings
 */
export async function readConfigText(path, kind, warnings) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    warnings.push(
      `Could not read the ${kind} ${path} (${errorCode(error)}), so Calavera skipped it.`,
    );
    return undefined;
  }
}

/**
 * The warning for a file that does not parse. A parser's message quotes the file, which can hold a
 * credential, so only the path and position are kept.
 * @param {string} path
 * @param {string} kind
 * @param {number | undefined} line
 * @param {number | undefined} column
 */
export function unparseableWarning(path, kind, line, column) {
  const position = line === undefined ? "" : ` at line ${line}, column ${column ?? 0}`;
  return `Could not parse the ${kind} ${path}${position}, so Calavera skipped it.`;
}
