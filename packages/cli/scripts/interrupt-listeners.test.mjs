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

for (const mode of ["signal-exit-first", "signal-exit-last"]) {
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    test(
      `with signal-exit's listener registered ${mode.replace("signal-exit-", "")}, ${signal} removes the folder and ends the process`,
      { skip },
      async () => {
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
      },
    );
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

        // The listener prints a second after its first call, so a signal raised again would have
        // called it a second time by then.
        assert.equal(await run.nextLine(), "calls 1");
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
