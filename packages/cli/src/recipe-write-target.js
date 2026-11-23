// @ts-check
import { lstat, opendir, readlink, realpath } from "node:fs/promises";
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
 * The error for a recipe path in a folder that does not exist, or that cannot be used. It keeps the file system's code and
 * error, which name only the path, so the failure stays diagnosable (#1208).
 *
 * @param {string} path
 * @param {NodeJS.ErrnoException} error
 */
async function missingFolderError(path, error) {
  const folder = dirname(path);
  const folderStats = await lstat(folder).catch(() => undefined);
  const why = folderStats?.isSymbolicLink()
    ? `${folder} is a link to ${await linkTarget(folder)}, which does not exist`
    : folderStats === undefined
      ? `the folder ${folder} does not exist`
      : folderStats.isDirectory()
        ? `the folder ${folder} cannot be opened (${error.code})`
        : `${folder} is not a folder`;
  return Object.assign(
    new Error(
      `Calavera cannot write the recipe at ${path}, because ${why}. Create the folder, or give a recipe path in a folder that exists and can be opened, then run apply again. ${STOPPED}`,
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
 * because apply would change that file. A path the caller gave outside the project, by its own
 * name and its folder's real path, is written as given, because no link leads it there. A path in
 * a folder that does not exist, or cannot be opened, stops with a Calavera error that names the
 * path, instead of the raw `ENOENT` the write would throw.
 *
 * @param {string} path Absolute recipe path.
 * @param {string} projectDirectory The directory apply runs in.
 * @returns {Promise<void>}
 */
export async function assertRecipeWriteTarget(path, projectDirectory) {
  const project = await realpath(projectDirectory);

  let folder;
  try {
    folder = await realpath(dirname(path));
    // A file where the folder should be resolves too; opening it as a folder fails with ENOTDIR.
    await (await opendir(folder)).close();
  } catch (error) {
    throw await missingFolderError(path, /** @type {NodeJS.ErrnoException} */ (error));
  }
  // A path that names the project, by any route, is held to it; only a path outside it both as
  // given and as resolved is the caller's own choice.
  const namedInside = isPathInside(project, path) || isPathInside(project, folder);
  // lstat does not follow a link at `path`. Any failure reads as nothing there, because the folder
  // was opened above, so the write reports anything else itself.
  const stats = await lstat(path).catch(() => undefined);

  if (stats?.isSymbolicLink()) {
    const target = await linkTarget(path);
    const real = await realpath(path).catch(() => undefined);
    if (real === undefined) {
      const outside = !isPathInside(project, await nearestExistingRealPath(target));
      throw new Error(
        `Calavera refused to write the recipe: ${path} is a link to ${target}, which does not exist${outside ? ` and is outside ${project}` : ""}, so writing the recipe would create ${target} instead. Remove the link, or point it at an existing file inside ${project}, then run apply again. ${STOPPED}`,
      );
    }
    if (namedInside && !isPathInside(project, real)) {
      throw new Error(
        `Calavera refused to write the recipe: ${path} is a link to ${real === target ? target : `${target}, at the real path ${real}`}, which is outside ${project}, so writing the recipe would change a file outside the project. Replace the link with the recipe file itself, or give a recipe path inside ${project}, then run apply again. ${STOPPED}`,
      );
    }
    return;
  }

  // The entry at `path` is not a link, so its real path is its folder's real path joined with its
  // name, whether it exists or not.
  const real = join(folder, basename(path));
  if (namedInside && !isPathInside(project, real)) {
    throw new Error(
      `Calavera refused to write the recipe: ${path} reaches ${real} through a folder link, which is outside ${project}, so writing the recipe would ${stats === undefined ? "create" : "change"} a file outside the project. Give a recipe path inside ${project} that no folder link leads out of, then run apply again. ${STOPPED}`,
    );
  }
}
