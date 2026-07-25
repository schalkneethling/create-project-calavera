// @ts-check
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * @param {string | Buffer} value
 * @returns {string}
 */
export function textHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 7);
}

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
export async function collectFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
    .slice(0, 7);
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function hashDirectory(path) {
  const files = (await collectFiles(path)).sort();
  const hash = createHash("sha256");

  for (const file of files) {
    hash.update(relative(path, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 7);
}
