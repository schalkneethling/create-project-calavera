// @ts-check
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

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
 * has not removed yet. They are the only folders the interrupt handler removes, each by its exact
 * path, because other runs keep folders with the same prefix in the system's temporary folder
 * (#1081). The set belongs to the process, as the signals it answers do.
 *
 * @type {Set<string>}
 */
const liveTemporaryFolders = new Set();
const INTERRUPT_SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM"]);

/**
 * How many listeners `signal` has that defer to the others: signal-exit's. Its listener, which
 * execa registers while a subprocess such as `vp fmt` runs, acts only when it finds no listener
 * but its own, and then ends the process by the signal. It counts its loaded copies in the
 * emitter that signal-exit 4 keeps under `Symbol.for("signal-exit emitter")` and signal-exit 3
 * keeps in `process.__signal_exit_emitter__`; each copy adds one listener to each signal.
 */
function deferringListenerCount() {
  const emitters = [
    Reflect.get(globalThis, Symbol.for("signal-exit emitter")),
    Reflect.get(process, "__signal_exit_emitter__"),
  ];
  return emitters.reduce((total, emitter) => {
    const count = emitter?.count;
    return total + (typeof count === "number" ? count : 0);
  }, 0);
}

/**
 * Whether no listener of `signal` but signal-exit's would keep the process running.
 *
 * @param {NodeJS.Signals} signal
 * @param {number} own How many of the listeners are this handler: 1 while it is attached.
 */
function onlyDeferringListeners(signal, own) {
  return process.listenerCount(signal) - own - deferringListenerCount() <= 0;
}

/**
 * Answers Ctrl+C (SIGINT) or SIGTERM while a temporary folder exists. The process ends by the
 * signal only when no listener but this one and signal-exit's would keep it running. Then this
 * handler removes every live folder, forgets them, detaches itself, and raises the signal again.
 * With no listener left, Node's default action ends the process. With signal-exit's listeners
 * left, each one ends the process by the signal once it finds no listener but signal-exit's:
 * during this delivery when it was registered after this handler, and on the raised signal when
 * it was registered before.
 *
 * The raised signal arrives on a later turn of the event loop. If signal-exit's last listener is
 * removed before then, as execa does when its subprocess ends, Node stops watching the signal and
 * the raised signal is lost. So on the next turn, when no listener but signal-exit's remains, this
 * handler raises the signal once more, which then ends the process.
 *
 * The removal is synchronous because the process ends right after the signal is raised again,
 * before any asynchronous removal could finish. Removal retries, because a copy into the folder
 * that is still in flight can make it fail with ENOTEMPTY; a folder that still cannot be removed
 * stays, as it would without this handler.
 *
 * When any other listener exists, that listener decides whether the process ends, and Node has
 * already called it for this delivery. This handler then removes nothing, because the run may go
 * on inside its folders, and it does not raise the signal again, so that listener runs once. It
 * stays attached, so the folders are removed on a later signal that ends the process, or by the
 * run's own cleanup. If that listener ends the process itself, for example with `process.exit()`,
 * the folders stay.
 *
 * @param {NodeJS.Signals} signal
 */
function removeLiveFoldersOnInterrupt(signal) {
  if (!onlyDeferringListeners(signal, 1)) return;
  for (const folder of liveTemporaryFolders) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // The process is ending, so nothing could report the failure.
    }
  }
  // The folders are gone, so a folder created later attaches this handler again.
  liveTemporaryFolders.clear();
  detachInterruptHandler();
  process.kill(process.pid, signal);
  setImmediate(() => {
    if (onlyDeferringListeners(signal, 0)) process.kill(process.pid, signal);
  });
}

function detachInterruptHandler() {
  for (const signal of INTERRUPT_SIGNALS) process.off(signal, removeLiveFoldersOnInterrupt);
}

/**
 * Creates a new, uniquely named folder in the system's temporary folder, whose name starts with
 * `prefix`, and removes it if Ctrl+C or SIGTERM interrupts the process before
 * `removeTemporaryFolder` removes it (#1081). The handlers are attached only while such a folder
 * exists, so a command that has removed its folders handles the signals as it did before.
 *
 * @param {string} prefix
 * @returns {Promise<string>}
 */
export async function createTemporaryFolder(prefix) {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  if (liveTemporaryFolders.size === 0) {
    for (const signal of INTERRUPT_SIGNALS) process.on(signal, removeLiveFoldersOnInterrupt);
  }
  liveTemporaryFolders.add(folder);
  return folder;
}

/**
 * Removes `folder` and everything in it, if it is there. A folder that `createTemporaryFolder`
 * made is no longer removed on an interrupt once this succeeds; when this fails, it still is.
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
    detachInterruptHandler();
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
