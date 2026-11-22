// Issue #1081: Calavera's temporary folders are removed by their exact paths when Ctrl+C (SIGINT)
// or SIGTERM ends the process, and the process still ends by the signal, while an execa subprocess
// runs too. A folder whose earlier removal failed is still removed. When another listener keeps
// the process running, the folder stays while the run goes on, and is removed when the process
// exits.
import assert from "node:assert/strict";
import { mkdtempDisposable, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startSignalChild } from "./signal-child.mjs";

const CHILD = fileURLToPath(new URL("./interrupt-listeners-child.mjs", import.meta.url));
// On Windows, a child process cannot handle a signal another process sends it.
const skip = process.platform === "win32";

const ENDING_MODES = {
  "subprocess-first": "with an execa subprocess started before the folder",
  "subprocess-last": "with an execa subprocess started after the folder",
  "failed-removal": "after removing the folder failed",
  recreated: "with a folder created after another was removed",
  "one-of-two-removed": "with one of two folders removed",
  "relative-tmpdir": "with a relative temporary folder and a changed working folder",
};

for (const [mode, situation] of Object.entries(ENDING_MODES)) {
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    test(
      `${situation}, ${signal} removes the folder and ends the process by the signal`,
      { skip },
      async () => {
        await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
        const run = startSignalChild(CHILD, [mode], owned.path);
        let folder;
        let code;
        let exitSignal;
        try {
          folder = await run.nextLine();
          // Real paths, because on macOS the system's temporary folder is behind a symbolic link.
          assert.equal(
            (await realpath(folder)).startsWith(await realpath(owned.path)),
            true,
            folder,
          );
          assert.equal((await stat(folder)).isDirectory(), true, "the folder exists");
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
    `with another ${signal} listener that keeps the process running, the folder stays until the process exits`,
    { skip },
    async () => {
      await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
      const run = startSignalChild(CHILD, ["other-listener"], owned.path);
      let folder;
      let code;
      try {
        folder = await run.nextLine();
        run.child.kill(signal);
        assert.equal(await run.nextLine(), "call 1");
        assert.equal(await run.nextLine(), "exists true", "the run goes on, so its folder stays");
        [code] = await run.exited();
      } finally {
        run.stop();
      }

      assert.equal(code, 0, "the other listener ended the process");
      await assert.rejects(stat(folder), { code: "ENOENT" }, "the folder is removed on exit");
    },
  );
}
