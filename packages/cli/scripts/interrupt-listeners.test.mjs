// Issue #1081: the handler that removes Calavera's temporary folders on Ctrl+C (SIGINT) or SIGTERM
// works with the other signal listeners a process can have. With signal-exit's listener, which
// execa registers while a subprocess runs, the process still ends by the signal, in either order.
// With a listener that keeps the process running, the handler leaves the folders in place, does
// not raise the signal again, and that listener runs once.
import assert from "node:assert/strict";
import { mkdtempDisposable, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startSignalChild } from "./signal-child.mjs";

const CHILD = fileURLToPath(new URL("./interrupt-listeners-child.mjs", import.meta.url));
// On Windows, a child process cannot handle a signal another process sends it.
const skip = process.platform === "win32";

const ENDING_MODES = {
  "signal-exit-first": "with signal-exit's listener registered first",
  "signal-exit-last": "with signal-exit's listener registered last",
  "signal-exit-leaves": "when signal-exit's listener is removed before the raised signal arrives",
  "signal-exit-3": "with signal-exit 3's listener registered first",
};

for (const [mode, situation] of Object.entries(ENDING_MODES)) {
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    test(`${situation}, ${signal} removes the folder and ends the process`, { skip }, async () => {
      await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
      const run = startSignalChild(CHILD, [mode], owned.path);
      let folder;
      let code;
      let exitSignal;
      try {
        folder = await run.nextLine();
        assert.equal(folder.startsWith(owned.path), true, folder);
        run.child.kill(signal);
        [code, exitSignal] = await run.exited();
      } finally {
        run.stop();
      }

      assert.equal(code, null);
      assert.equal(exitSignal, signal, "the process ends by the signal it received");
      await assert.rejects(stat(folder), { code: "ENOENT" });
    });
  }
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  test(
    `with another ${signal} listener that keeps the process running, the folder stays and that listener runs once`,
    { skip },
    async () => {
      await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
      const run = startSignalChild(CHILD, ["other-listener"], owned.path);
      try {
        const folder = await run.nextLine();
        run.child.kill(signal);

        // "done" arrives after any signal Calavera raised again during the first call.
        assert.equal(await run.nextLine(), "call 1");
        assert.equal(await run.nextLine(), "done", "the other listener runs once");
        assert.equal(run.child.exitCode, null, "the other listener keeps the process running");
        assert.equal(run.child.signalCode, null);
        assert.equal(
          (await stat(folder)).isDirectory(),
          true,
          "the run goes on, so its folder stays",
        );
      } finally {
        run.stop();
      }
    },
  );
}
