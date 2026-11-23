// @ts-check
import { constants } from "node:fs";
import { access, lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isPathInside } from "./utils/fs.js";

const STOPPED = "Calavera stopped before writing anything.";

/**
 * Where the link at `path` points, resolved against the link's folder, without following it any
 * further. This is the target `ls -l` shows.
 *
 * @param {string} path
 */
async function linkTarget(path) {
  return resolve(dirname(path), await readlink(path));
}

/**
 * The real path of the nearest folder above `path`, or `path` itself, that exists. A path is
 * inside the project exactly when that folder is, because the missing part below it cannot lead
 * anywhere else. The file system root always resolves, so the walk ends there; the guard only
 * stops a root that does not, such as a missing Windows drive.
 *
 * @param {string} path Absolute path.
 */
async function nearestExistingRealPath(path) {
  let existing = path;
  for (;;) {
    try {
      return await realpath(existing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        return existing;
      }
      existing = parent;
    }
  }
}

/**
 * The error for a recipe path in a folder that does not exist, is not a folder, or cannot be
 * entered, named by `error.code`, whether the folder is a link or not. It keeps the file system's
 * code and error, which name only the path, so the failure stays diagnosable (#1208).
 *
 * @param {string} path
 * @param {NodeJS.ErrnoException} error
 * @param {string} command The command the remedy tells the person to run again.
 */
async function missingFolderError(path, error, command) {
  const folder = dirname(path);
  const folderStats = await lstat(folder).catch(() => undefined);
  const problem =
    error.code === "ENOENT"
      ? "does not exist"
      : error.code === "ENOTDIR"
        ? "is not a folder"
        : `cannot be opened (${error.code})`;
  const why = folderStats?.isSymbolicLink()
    ? `${folder} is a link to ${await linkTarget(folder)}, which ${problem}`
    : error.code === "ENOTDIR"
      ? `${folder} ${problem}`
      : `the folder ${folder} ${problem}`;
  return Object.assign(
    new Error(
      `Calavera cannot write the recipe at ${path}, because ${why}. Create the folder, or give a recipe path in a folder that exists and can be opened, then run ${command} again. ${STOPPED}`,
      { cause: error },
    ),
    { code: error.code },
  );
}

/**
 * #1208: stops before anything is written when writing the recipe at `path` would create or change
 * a file somewhere other than `path` names. A link at `path` that does not reach an existing file
 * always stops apply, because writing through it would create its target, wherever that is. A link,
 * at `path` or at a folder on the way to it, that reaches a file outside the project stops apply,
 * because apply would change that file. Any other path whose real destination is outside the
 * project stops apply too, whatever route names it: the comparison is between real paths, so an
 * alias of the project, such as /var for /private/var on macOS or a case variant on a file system
 * that ignores case, cannot carry a write out through a folder link. A path in a folder that does
 * not exist, is not a folder, or cannot be entered, and a path that is or reaches a folder, stop
 * with a Calavera error that names the path, instead of the raw error the write would throw.
 *
 * The check covers symbolic links and junctions only, not hard links (owner decision on #1208). A
 * hard link has no direction, so a recipe file that shares its contents with a file outside the
 * project looks like any other file, and apply writes it as one.
 *
 * @param {string} path Absolute recipe path.
 * @param {string} projectDirectory The directory apply or init runs in.
 * @param {string} [command] The command that writes the recipe, which each message tells the person
 *   to run again: init writes the recipe itself before it applies, so it passes "init" (#1220).
 * @returns {Promise<void>}
 */
export async function assertRecipeWriteTarget(path, projectDirectory, command = "apply") {
  const project = await realpath(projectDirectory);

  let folder;
  try {
    folder = await realpath(dirname(path));
    // A file where the folder should be resolves too, so it is checked as a folder. Creating a file
    // needs the folder to be entered, not listed, so only search permission is checked.
    if (!(await stat(folder)).isDirectory()) {
      throw Object.assign(new Error(`${folder} is not a directory`), { code: "ENOTDIR" });
    }
    await access(folder, constants.X_OK);
  } catch (error) {
    throw await missingFolderError(path, /** @type {NodeJS.ErrnoException} */ (error), command);
  }
  // lstat does not follow a link at `path`. Any failure reads as nothing there, because the folder
  // was opened above, so the write reports anything else itself.
  const stats = await lstat(path).catch(() => undefined);

  if (stats?.isSymbolicLink()) {
    const target = await linkTarget(path);
    const resolved = await realpath(path).then(
      (real) => ({ real, failure: undefined }),
      (/** @type {NodeJS.ErrnoException} */ failure) => ({ real: undefined, failure }),
    );
    if (resolved.failure !== undefined) {
      const { failure } = resolved;
      if (failure.code !== "ENOENT") {
        // A loop, or a target that cannot be reached, is not a missing file, so it is not called
        // one.
        throw Object.assign(
          new Error(
            `Calavera refused to write the recipe: ${path} is a link to ${target}, which does not lead to a file (${failure.code}), so Calavera cannot tell where writing the recipe would land. Replace the link with the recipe file itself, then run ${command} again. ${STOPPED}`,
            { cause: failure },
          ),
          { code: failure.code },
        );
      }
      const outside = !isPathInside(project, await nearestExistingRealPath(target));
      throw new Error(
        `Calavera refused to write the recipe: ${path} is a link to ${target}, which does not exist${outside ? ` and is outside ${project}` : ""}, so writing the recipe would create ${target} instead. Remove the link, or point it at an existing file inside ${project}, then run ${command} again. ${STOPPED}`,
      );
    }
    const { real } = resolved;
    if (!isPathInside(project, real)) {
      throw new Error(
        `Calavera refused to write the recipe: ${path} is a link to ${real === target ? target : `${target}, at the real path ${real}`}, which is outside ${project}, so writing the recipe would change a file outside the project. Replace the link with the recipe file itself, or give a recipe path inside ${project}, then run ${command} again. ${STOPPED}`,
      );
    }
    await assertNotFolder(path, real, command);
    return;
  }

  // The entry at `path` is not a link, so its real path is its folder's real path joined with its
  // name, whether it exists or not.
  const real = join(folder, basename(path));
  if (!isPathInside(project, real)) {
    const where = real === path ? `${path} is` : `${path} resolves to ${real}, which is`;
    throw new Error(
      `Calavera refused to write the recipe: ${where} outside ${project}, so writing the recipe would ${stats === undefined ? "create" : "change"} a file outside the project. Give a recipe path inside ${project}, then run ${command} again. ${STOPPED}`,
    );
  }
  if (stats?.isDirectory()) {
    await assertNotFolder(path, real, command);
  }
}

/**
 * Stops with a Calavera error, instead of the raw `EISDIR` the write would throw, when the recipe
 * path, or the file a link there reaches, is a folder.
 *
 * @param {string} path
 * @param {string} real
 * @param {string} command The command the remedy tells the person to run again.
 */
async function assertNotFolder(path, real, command) {
  if ((await lstat(real)).isDirectory()) {
    throw Object.assign(
      new Error(
        `Calavera cannot write the recipe at ${path}, because ${real === path ? path : `it leads to ${real}, which`} is a folder. Give a recipe path that names a file, then run ${command} again. ${STOPPED}`,
      ),
      { code: "EISDIR" },
    );
  }
}
