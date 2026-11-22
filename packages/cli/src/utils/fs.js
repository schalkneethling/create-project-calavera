// @ts-check
import { lstatSync, readFileSync } from "node:fs";
import { access, constants, realpath, readFile, writeFile } from "node:fs/promises";
import nodePath, { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { jsonSyntaxProblem } from "./parse-position.js";

const TEMPLATE_LIMIT = 256 * 1024;

/**
 * Whether `child` is `parent` itself or lies below it, compared by name: links are not resolved,
 * so a caller that must see through links resolves them first. `relative` normalizes its result,
 * so a path outside is `..`, starts with `..` and a separator, or stays absolute when it is on
 * another Windows drive. A name that only starts with `..`, such as `..recipe.json`, is inside
 * (owner decision on #1026).
 *
 * @param {string} parent
 * @param {string} child
 * @param {Pick<typeof nodePath, "relative" | "isAbsolute" | "sep">} [pathRules] The platform's
 *   path rules; tests pass `posix` or `win32`.
 */
export function isPathInside(parent, child, pathRules = nodePath) {
  const fromParent = pathRules.relative(parent, child);
  return (
    fromParent !== ".." &&
    !fromParent.startsWith(`..${pathRules.sep}`) &&
    !pathRules.isAbsolute(fromParent)
  );
}

/** @param {string} path @param {string} [label] */
export function assertSafeRelativePath(path, label = "Path") {
  const normalized = relative(".", resolve(path));
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..") ||
    !normalized ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    isAbsolute(normalized)
  ) {
    throw new Error(`${label} must stay inside the current project workspace.`);
  }
  return path;
}

/** @param {string} path @param {string} [root] @param {string} [label] */
export async function assertWorkspacePath(path, root = process.cwd(), label = "Path") {
  const canonicalRoot = await realpath(root);
  const target = resolve(root, path);
  let ancestor = target;
  while (!(await fileExists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = await realpath(ancestor);
  const relativeAncestor = relative(canonicalRoot, canonicalAncestor);
  if (
    relativeAncestor === ".." ||
    relativeAncestor.startsWith(`..${sep}`) ||
    isAbsolute(relativeAncestor)
  ) {
    throw new Error(`${label} must stay inside the current project workspace.`);
  }
  return target;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and parses the JSON file at `path`. A file that is missing or cannot be read rejects with
 * the error from `readFile`, which carries its code, such as `ENOENT` or `EISDIR`. A file that is
 * not valid JSON rejects with a `JSONParseError`, a `SyntaxError` that names the file and the
 * line and column of the error, and has no `cause`: `JSON.parse`'s own message quotes the text
 * around the error, which can hold a secret, so it never reaches a message, a cause, or a log
 * (#1157).
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function readJSON(path) {
  return parseJSON(await readFile(path, "utf8"), path);
}

/**
 * Parses `text`, read from the file at `path`, as `readJSON` does: text that is not valid JSON
 * throws a `JSONParseError`, never `JSON.parse`'s own error. For a caller that has already read
 * the file, such as one that keeps the exact bytes it validated.
 *
 * @param {string} text
 * @param {string} path Names the file in the error.
 * @returns {unknown}
 */
export function parseJSON(text, path) {
  try {
    return JSON.parse(text);
  } catch {
    throw new JSONParseError(path, jsonSyntaxProblem(text));
  }
}

/**
 * The error `readJSON` and `parseJSON` throw for a file that is not valid JSON. `problem` says
 * what is wrong and where, such as "InvalidSymbol at line 3, column 14", for a caller that names
 * the file itself.
 */
export class JSONParseError extends SyntaxError {
  /**
   * @param {string} path
   * @param {string} problem From `jsonSyntaxProblem`, so it holds no text from the file.
   */
  constructor(path, problem) {
    super(
      `${path} cannot be parsed as JSON: ${problem}. Correct the JSON there, then run the command again.`,
    );
    this.problem = problem;
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 * @param {boolean} dryRun
 */
export async function writeJSON(path, value, dryRun) {
  if (dryRun) {
    return;
  }

  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Reads a template that ships with the CLI, refusing anything but a regular
 * file within the size limit.
 *
 * @param {URL} url
 * @param {string} label names the template in errors, such as "Repository-controls"
 */
export function readBoundedTemplate(url, label) {
  const before = lstatSync(url);
  if (!before.isFile()) throw new Error(`${label} template must be a regular file.`);
  if (before.size > TEMPLATE_LIMIT) {
    throw new Error(`${label} template exceeds ${TEMPLATE_LIMIT} bytes.`);
  }
  const contents = readFileSync(url);
  if (contents.byteLength > TEMPLATE_LIMIT) {
    throw new Error(`${label} template exceeded ${TEMPLATE_LIMIT} bytes while reading.`);
  }
  return contents.toString("utf8");
}
