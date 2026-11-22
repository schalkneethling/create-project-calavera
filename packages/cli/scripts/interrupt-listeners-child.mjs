// The child process of interrupt-listeners.test.mjs (#1081). It records a temporary folder with
// createTemporaryFolder in the situation its first argument names, prints the folder's path, and
// then waits until the test signals it.
//
// - "subprocess-first" and "subprocess-last": an execa subprocess is running, started before or
//   after the folder is created, as `vp fmt` runs while apply plans.
// - "failed-removal": removeTemporaryFolder fails to remove the folder, so the folder stays.
// - "recreated": the first folder is removed, and a second one is created.
// - "other-listener": a SIGINT and SIGTERM listener that keeps the process running, as a "press
//   Ctrl+C again to quit" prompt would. It prints a line each time it runs. After its first call,
//   it prints whether the folder still exists, and then ends the process with process.exit(0).
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

import { execa } from "execa";

import { createTemporaryFolder, removeTemporaryFolder } from "../src/utils/cleanup.js";

const [mode] = process.argv.slice(2);

// execa registers its signal-exit callback synchronously when it starts the subprocess.
function startSubprocess() {
  // The subprocess ends itself after two minutes, so a failing test cannot leave it running.
  const subprocess = execa(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"]);
  // The subprocess ends with the signal that ends this process; that rejection is expected.
  subprocess.catch(() => {});
}

if (mode === "subprocess-first") startSubprocess();
let folder = await createTemporaryFolder("calavera-locked-artifact-");
if (mode === "subprocess-last") startSubprocess();
if (mode === "failed-removal") {
  const busy = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
  fsPromises.rm = () => Promise.reject(busy);
  syncBuiltinESMExports();
  await removeTemporaryFolder(folder).then(
    () => {
      throw new Error("The removal was expected to fail.");
    },
    () => {},
  );
}
if (mode === "recreated") {
  await removeTemporaryFolder(folder);
  folder = await createTemporaryFolder("calavera-locked-artifact-");
}
if (mode === "other-listener") {
  let calls = 0;
  const otherListener = () => {
    calls += 1;
    process.stdout.write(`call ${calls}\n`);
    if (calls === 1) {
      setImmediate(() => {
        process.stdout.write(`exists ${existsSync(folder)}\n`);
        process.exit(0);
      });
    }
  };
  process.on("SIGINT", otherListener);
  process.on("SIGTERM", otherListener);
}

process.stdout.write(`${folder}\n`);
// Keeps the event loop alive until the test signals the process.
setInterval(() => {}, 60_000);
