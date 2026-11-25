// Temporary folders for tests. Each one is recorded by its exact path and removed after the test
// that created it, so repeated runs and Stryker do not fill the shared temporary folder. Removal
// never works by prefix or glob, because other sessions keep files in the same folder.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTemporaryFolder } from "../../../scripts/temporary-folder.mjs";

/** @type {string[]} */
const created = [];

/**
 * A new, empty folder in the operating system's temporary folder.
 * @param {string} prefix
 */
export async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

/**
 * Removes every folder that temporaryDirectory created since the last call, including folders a
 * test made read-only. Use in a top-level afterEach. node:test also runs that hook after each
 * subtest, so a test that creates a folder must not start subtests with t.test, or the first
 * subtest's hook removes the parent's folder.
 */
export async function removeTemporaryDirectories() {
  for (const directory of created.splice(0)) {
    await removeTemporaryFolder(directory);
  }
}
