// @ts-check
import { access, constants, readFile, writeFile } from "node:fs/promises";

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
