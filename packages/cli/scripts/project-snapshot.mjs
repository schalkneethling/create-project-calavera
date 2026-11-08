// Shared by the tests that assert a command left a project directory unchanged.
import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Maps every directory below `directory` to "directory", every symbolic link to its target, without
 * following it, and every file to a hash of its contents.
 *
 * @param {string} [directory]
 * @returns {Promise<Record<string, string>>}
 */
export async function snapshotDirectory(directory = ".") {
  /** @type {Record<string, string>} */
  const entries = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      entries[`${path}/`] = "directory";
      Object.assign(entries, await snapshotDirectory(path));
    } else if (entry.isSymbolicLink()) {
      entries[path] = `link to ${await readlink(path)}`;
    } else {
      entries[path] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
  return entries;
}
