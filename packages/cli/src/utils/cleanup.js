// @ts-check
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { onExit } from "signal-exit";

/**
 * The failures of one or more cleanups. A cleanup that runs further cleanups throws this, so the
 * caller can merge its failures into one flat list instead of nesting them.
 */
export class CleanupError extends AggregateError {}

/** @param {unknown} error */
const reasonOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Runs every cleanup, even when another fails, and returns their failures. The cleanups run at the
 * same time, so each must be independent of the others, such as removing separate folders. A
 * cleanup that throws instead of rejecting counts as failed, so the others still run.
 *
 * @param {Array<() => Promise<unknown>>} cleanups
 * @returns {Promise<unknown[]>}
 */
export async function cleanupFailures(cleanups) {
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    return result.reason instanceof CleanupError ? result.reason.errors : [result.reason];
  });
}

/**
 * Runs every cleanup at the same time, even when another fails, and then throws a CleanupError
 * that lists each failure, if any.
 *
 * @param {Array<() => Promise<unknown>>} cleanups
 */
export async function runCleanups(cleanups) {
  const failures = await cleanupFailures(cleanups);
  if (failures.length > 0) {
    throw new CleanupError(
      failures,
      `Could not remove Calavera's temporary folders: ${failures.map(reasonOf).join(" ")}`,
    );
  }
}

/**
 * Runs every cleanup at the same time after `error` stopped a command, even when a cleanup fails,
 * and returns the error to throw: `error` itself when every cleanup succeeded, and otherwise an
 * AggregateError that lists `error` first and then each cleanup failure, and keeps `error` as its
 * cause, so neither the original failure nor a cleanup failure is lost.
 *
 * @param {unknown} error
 * @param {Array<() => Promise<unknown>>} cleanups
 * @returns {Promise<unknown>}
 */
export async function errorAfterCleanups(error, cleanups) {
  const failures = await cleanupFailures(cleanups);
  if (failures.length === 0) return error;
  return new AggregateError(
    [error, ...failures],
    `${reasonOf(error)} Removing Calavera's temporary folders also failed: ${failures.map(reasonOf).join(" ")}`,
    { cause: error },
  );
}

/**
 * A temporary folder Calavera could not remove, and why, with what the person can do.
 *
 * @typedef {{ path: string, reason: string }} TemporaryFolderLeftover
 */

/**
 * The error a temporary folder removal rejects with: it names the folder, not the entry inside it
 * that failed, and keeps only the error's code in its message, because the message of the original
 * error, which stays as the cause, can carry text from the person's configuration.
 */
export class TemporaryFolderError extends Error {
  /**
   * @param {string} folder
   * @param {unknown} cause
   */
  constructor(folder, cause) {
    const code = /** @type {{ code?: unknown }} */ (cause)?.code;
    super(`Could not remove ${folder}${typeof code === "string" ? ` (${code})` : ""}.`, { cause });
    this.path = folder;
    this.code = typeof code === "string" ? code : undefined;
  }
}

/**
 * The temporary folders `createTemporaryFolder` made in this process and `removeTemporaryFolder`
 * has not removed yet. They are the only folders the exit callback removes, each by its exact
 * path, because other runs keep folders with the same prefix in the system's temporary folder
 * (#1081). The set belongs to the process, as the exit it answers does.
 *
 * @type {Set<string>}
 */
const liveTemporaryFolders = new Set();

/**
 * Unregisters the exit callback, while one is registered.
 *
 * @type {(() => void) | undefined}
 */
let removeExitCallback;

/**
 * Removes every live temporary folder as the process exits. signal-exit's `onExit` calls this when
 * the process exits normally, through `process.exit()`, or by a signal such as Ctrl+C (SIGINT) or
 * SIGTERM, and then ends the process by that signal itself. signal-exit shares one set of signal
 * listeners among every `onExit` registration in the process, such as the one execa makes for each
 * subprocess, so they cooperate.
 *
 * signal-exit calls this for a signal only when the signal would end the process, that is, when no
 * listener outside signal-exit handles it. When another listener handles the signal, such as a
 * "press Ctrl+C again to quit" prompt, the process keeps running, and so does the run inside its
 * folders, so nothing is removed then. The folders are removed later, when the process exits
 * normally, through `process.exit()`, or by a signal that no other listener handles. Nothing can
 * remove them when SIGKILL or a crash of Node itself ends the process.
 *
 * A folder whose earlier removal failed, which the command has already reported as left behind,
 * stays recorded, so this tries to remove it once more when the process exits.
 *
 * The removal is synchronous, because the process ends as soon as this returns. Removal retries,
 * because a copy into the folder that is still in flight can make it fail with ENOTEMPTY; a folder
 * that still cannot be removed stays, as it would without this callback.
 */
function removeLiveFoldersOnExit() {
  for (const folder of liveTemporaryFolders) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // The process is ending, so nothing could report the failure.
    }
  }
}

/**
 * Creates a new, uniquely named folder in the system's temporary folder, whose name starts with
 * `prefix`, and removes it if the process exits, for example because Ctrl+C or SIGTERM interrupts
 * it, before `removeTemporaryFolder` removes it (#1081). The exit callback is registered only while
 * such a folder exists.
 *
 * @param {string} prefix
 * @returns {Promise<string>}
 */
export async function createTemporaryFolder(prefix) {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  liveTemporaryFolders.add(folder);
  removeExitCallback ??= onExit(removeLiveFoldersOnExit);
  return folder;
}

/**
 * Removes `folder` and everything in it, if it is there. A folder that `createTemporaryFolder`
 * made is no longer removed when the process exits once this succeeds; when this fails, it still
 * is.
 *
 * @param {string} folder
 * @returns {Promise<void>}
 */
export async function removeTemporaryFolder(folder) {
  try {
    await rm(folder, { recursive: true, force: true });
  } catch (error) {
    throw new TemporaryFolderError(folder, error);
  }
  if (liveTemporaryFolders.delete(folder) && liveTemporaryFolders.size === 0) {
    removeExitCallback?.();
    removeExitCallback = undefined;
  }
}

const LEFTOVER_REMEDY = "Nothing in the project uses it, so remove it yourself.";
const IN_PROJECT_NOTE =
  "It is inside the project and Git does not ignore it, so remove it before you commit.";

/** @param {unknown} error */
function codeOf(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  return typeof code === "string" ? ` (${code})` : "";
}

/**
 * Each folder that `failures`, the result of `cleanupFailures` after a command has done its work,
 * left behind, with the error's code and the remedy, and never the error's message. A temporary
 * folder that stays changes nothing in the project, so a command reports it instead of stopping
 * (#1033, owner decision of 2026-11-18). A failure that names no folder is still listed, with an
 * empty path and its code, so the person learns that something was left; its stack stays only on
 * the error, which `errorWithLeftovers` keeps when a later step fails.
 *
 * @param {unknown[]} failures
 * @returns {TemporaryFolderLeftover[]}
 */
export function temporaryFolderLeftovers(failures) {
  return failures.map((failure) => {
    if (!(failure instanceof TemporaryFolderError)) {
      return {
        path: "",
        reason: `Calavera could not remove one of its temporary folders${codeOf(failure)}. Look for a calavera- folder in the system's temporary folder or in .calavera/.transactions/, and remove it.`,
      };
    }
    const fromProject = relative(process.cwd(), failure.path);
    const inProject = !fromProject.startsWith("..") && !isAbsolute(fromProject);
    return {
      path: failure.path,
      reason: `Calavera could not remove this temporary folder${codeOf(failure)}. ${LEFTOVER_REMEDY}${inProject ? ` ${IN_PROJECT_NOTE}` : ""}`,
    };
  });
}

/**
 * One line for each leftover, as the apply summary and a message that reports a later failure
 * print it.
 *
 * @param {TemporaryFolderLeftover} leftover
 */
export function temporaryFolderLeftoverLine({ path, reason }) {
  return path === "" ? `Not removed: ${reason}` : `Not removed ${path}: ${reason}`;
}

/**
 * The error to throw when `error` stopped a command after its cleanup left the folders `failures`
 * names: `error` itself when nothing was left, and otherwise an AggregateError that lists `error`
 * first and then each cleanup failure, keeps `error` as its cause, and adds a line for each folder
 * to the message, so a later failure never hides a folder the person has to remove.
 *
 * @param {unknown} error
 * @param {unknown[]} failures
 * @returns {unknown}
 */
export function errorWithLeftovers(error, failures) {
  if (failures.length === 0) return error;
  return new AggregateError(
    [error, ...failures],
    [reasonOf(error), ...temporaryFolderLeftovers(failures).map(temporaryFolderLeftoverLine)].join(
      "\n",
    ),
    { cause: error },
  );
}
