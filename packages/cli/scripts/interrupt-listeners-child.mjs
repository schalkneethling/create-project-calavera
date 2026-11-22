// The child process of interrupt-listeners.test.mjs (#1081). It creates one temporary folder with
// createTemporaryFolder, next to the signal listener its first argument names, prints the folder's
// path, and then waits until the test signals it.
//
// - "signal-exit-first" and "signal-exit-last": signal-exit's onExit, which execa registers while a
//   subprocess such as `vp fmt` runs, is registered before or after the folder is created.
// - "other-listener": a plain SIGINT and SIGTERM listener that keeps the process running, as a
//   "press Ctrl+C again to quit" prompt would. It prints how often it ran once later deliveries of
//   the signal would have arrived.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createTemporaryFolder } from "../src/utils/cleanup.js";

const [mode] = process.argv.slice(2);

// signal-exit is execa's dependency, not this package's, so it resolves from execa's folder.
const execaManifest = realpathSync(
  fileURLToPath(new URL("../node_modules/execa/package.json", import.meta.url)),
);
const loadOnExit = () => createRequire(execaManifest)("signal-exit").onExit;

if (mode === "signal-exit-first") loadOnExit()(() => {});
if (mode === "other-listener") {
  let calls = 0;
  const otherListener = () => {
    calls += 1;
    if (calls === 1) setTimeout(() => process.stdout.write(`calls ${calls}\n`), 1_000);
  };
  process.on("SIGINT", otherListener);
  process.on("SIGTERM", otherListener);
}
const folder = await createTemporaryFolder("calavera-locked-artifact-");
if (mode === "signal-exit-last") loadOnExit()(() => {});

process.stdout.write(`${folder}\n`);
// Keeps the event loop alive until the test signals the process.
setInterval(() => {}, 60_000);
