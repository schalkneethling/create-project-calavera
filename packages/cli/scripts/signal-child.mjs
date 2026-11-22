// Starts a child process that a #1081 test signals, with a system temporary folder the test owns,
// and reads its output line by line. Every wait is bounded, so a child that never answers or never
// ends fails the test instead of hanging it, and `stop` kills a child that is still running.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("./no-version-check.mjs", import.meta.url));
// The children take seconds; the bound is generous for a loaded machine.
export const WAIT_MS = 120_000;

/**
 * Settles with `promise`, or rejects with `message` once `WAIT_MS` passes.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {string} message
 * @returns {Promise<T>}
 */
export async function bounded(promise, message) {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(WAIT_MS, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

/**
 * @param {string} script The child script's path.
 * @param {string[]} args
 * @param {string} temporaryRoot The child's system temporary folder.
 */
export function startSignalChild(script, args, temporaryRoot) {
  const child = spawn(process.execPath, ["--import", PRELOAD, script, ...args], {
    env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  /** @type {string[]} */
  const queued = [];
  /** @type {((line: string) => void) | undefined} */
  let waiting;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (waiting) {
      const resolveLine = waiting;
      waiting = undefined;
      resolveLine(line);
    } else {
      queued.push(line);
    }
  });

  return {
    child,
    /** The exit code and signal, once the child ends within `WAIT_MS`. */
    exited: () => bounded(exited, `The child did not end within ${WAIT_MS} ms`),
    /** The child's next line of output, within `WAIT_MS`. */
    nextLine: () => {
      const line = queued.shift();
      if (line !== undefined) return Promise.resolve(line);
      const next = new Promise((resolveLine, rejectLine) => {
        waiting = resolveLine;
        exited.then(([code, signal]) =>
          rejectLine(new Error(`The child ended (${code ?? signal}) early: ${stderr}`)),
        );
      });
      return bounded(next, `The child printed nothing within ${WAIT_MS} ms: ${stderr}`);
    },
    /** Kills the child if it is still running. */
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}
