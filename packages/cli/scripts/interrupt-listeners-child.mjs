// The child process of interrupt-listeners.test.mjs (#1081). It creates one temporary folder with
// createTemporaryFolder, next to the signal listener its first argument names, prints the folder's
// path, and then waits until the test signals it.
//
// - "signal-exit-first" and "signal-exit-last": signal-exit's onExit, which execa registers while a
//   subprocess such as `vp fmt` runs, is registered before or after the folder is created.
// - "signal-exit-leaves": signal-exit is registered first, and its listener is removed right after
//   Calavera raises the signal again, before that signal arrives, as execa removes it when its
//   subprocess ends in that moment.
// - "signal-exit-3": a stand-in for signal-exit 3, which counts its copies in
//   `process.__signal_exit_emitter__` and, like signal-exit 4, acts only when it is the only
//   listener. It is registered first.
// - "other-listener": a plain SIGINT and SIGTERM listener that keeps the process running, as a
//   "press Ctrl+C again to quit" prompt would. It prints a line each time it runs. After its first
//   call, it sends the process SIGUSR2, whose listener prints "done". Signals a process sends itself
//   arrive in the order they were sent, so a signal that Calavera raised again during the first
//   call would print its line before "done".
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createTemporaryFolder } from "../src/utils/cleanup.js";

const [mode] = process.argv.slice(2);

// signal-exit is execa's dependency, not this package's, so it resolves from execa's folder.
const execaManifest = realpathSync(
  fileURLToPath(new URL("../node_modules/execa/package.json", import.meta.url)),
);
/** @returns {(callback: () => void) => () => void} */
const loadOnExit = () => createRequire(execaManifest)("signal-exit").onExit;

if (mode === "signal-exit-first") loadOnExit()(() => {});
if (mode === "signal-exit-leaves") {
  const removeOnExit = loadOnExit()(() => {});
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    const sent = kill(pid, signal);
    removeOnExit();
    return sent;
  };
}
if (mode === "signal-exit-3") {
  Object.assign(process, { __signal_exit_emitter__: { count: 1 } });
  /** @param {NodeJS.Signals} signal */
  const signalExit3 = (signal) => {
    if (process.listenerCount(signal) !== 1) return;
    process.off("SIGINT", signalExit3);
    process.off("SIGTERM", signalExit3);
    process.kill(process.pid, signal);
  };
  process.on("SIGINT", signalExit3);
  process.on("SIGTERM", signalExit3);
}
if (mode === "other-listener") {
  let calls = 0;
  const otherListener = () => {
    calls += 1;
    process.stdout.write(`call ${calls}\n`);
    if (calls === 1) setImmediate(() => process.kill(process.pid, "SIGUSR2"));
  };
  process.on("SIGINT", otherListener);
  process.on("SIGTERM", otherListener);
  process.on("SIGUSR2", () => process.stdout.write("done\n"));
}
const folder = await createTemporaryFolder("calavera-locked-artifact-");
if (mode === "signal-exit-last") loadOnExit()(() => {});

process.stdout.write(`${folder}\n`);
// Keeps the event loop alive until the test signals the process.
setInterval(() => {}, 60_000);
