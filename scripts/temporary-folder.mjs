// Temporary folders for tests (#1076). temporaryFolder creates a folder and registers its removal
// in the same call, so nothing between the two can fail and leave the folder behind, and the
// removal runs when the test ends, whether it passed or failed. Removal works only on the exact
// path that mkdtemp returned, never by prefix or glob, because other sessions and test runs keep
// files in the same system temporary folder.
import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a new, empty folder in the system temporary folder and removes it, with everything in
 * it, after the test ends.
 *
 * Pass the test's context (`t`) for a folder that one test uses. For a folder that several tests in
 * a file share, pass `{ after }` with node:test's `after`, called at the top level of the file,
 * because `after` called inside a running test attaches to that test.
 * @param {{ after: (hook: () => Promise<void>) => unknown }} context
 * @param {string} prefix The start of the folder's name, for example `calavera-registry-extract-`.
 */
export async function temporaryFolder(context, prefix) {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => removeTemporaryFolder(folder));
  return folder;
}

/**
 * Runs `callback`, then removes `folder` whether the callback succeeded or failed, for a fixture
 * that has no test context. When both fail, the AggregateError it throws keeps the callback's
 * error first, and as its cause, so the test's own failure is not hidden behind the cleanup's.
 * When only the removal fails, its error is thrown.
 * @template T
 * @param {string} folder
 * @param {() => Promise<T>} callback
 */
export async function removeTemporaryFolderAfter(folder, callback) {
  /** @type {T} */
  let result;
  try {
    result = await callback();
  } catch (failure) {
    try {
      await removeTemporaryFolder(folder);
    } catch (removalFailure) {
      throw new AggregateError(
        [failure, removalFailure],
        `The test failed, and removing its temporary folder ${folder} failed too.`,
        { cause: failure },
      );
    }
    throw failure;
  }
  await removeTemporaryFolder(folder);
  return result;
}

/**
 * Removes a folder and everything in it. A folder that a test made read-only cannot have its
 * entries removed, so on a permission error this gives the owner full permission on every folder
 * inside, then removes it again.
 * @param {string} folder
 */
export async function removeTemporaryFolder(folder) {
  try {
    await rm(folder, { recursive: true, force: true });
  } catch (error) {
    // Unix reports a folder without write permission as EACCES; Windows reports EPERM.
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    await restoreFolderPermissions(folder);
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Gives the owner read, write, and search permission on `folder` and on every folder inside it.
 * Symbolic links are not followed, so a link to a folder outside is left as it is.
 * @param {string} folder
 */
async function restoreFolderPermissions(folder) {
  const stats = await lstat(folder);
  if (!stats.isDirectory()) return;
  // The owner can change a folder's mode without any permission on the folder itself, and must,
  // before readdir can list a folder without read or search permission.
  await chmod(folder, stats.mode | 0o700);
  for (const name of await readdir(folder)) await restoreFolderPermissions(join(folder, name));
}
