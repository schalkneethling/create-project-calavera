// @ts-check
import { access, constants, realpath, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
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
