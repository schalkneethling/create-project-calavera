// Issue #1081: a dry run that Ctrl+C (SIGINT) or SIGTERM interrupts removes the temporary folders
// it created, by their exact paths, and leaves every other folder in the system's temporary
// folder alone, including another run's folder with the same prefix.
import assert from "node:assert/strict";
import { mkdir, mkdtempDisposable, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startSignalChild } from "./signal-child.mjs";

const CHILD = fileURLToPath(new URL("./interrupted-dry-run-child.mjs", import.meta.url));
const ANOTHER_RUN = ["calavera-locked-artifact-another-run", "calavera-artifact-stage-another-run"];

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  // On Windows, a child process cannot handle a signal another process sends it.
  test(
    `a mixed locked and unlocked dry run that ${signal} interrupts removes only the temporary folders it created`,
    { skip: process.platform === "win32" },
    async () => {
      // One folder the test owns holds the child's system temporary folder and its project, so
      // disposing it removes everything the run left, whatever the outcome.
      await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
      const temporaryRoot = { path: join(owned.path, "tmp") };
      const project = { path: join(owned.path, "project") };
      await mkdir(temporaryRoot.path);
      await mkdir(project.path);
      // Another run's folders, with the same prefixes as the ones the dry run creates.
      for (const name of ANOTHER_RUN) {
        await mkdir(join(temporaryRoot.path, name));
        await writeFile(join(temporaryRoot.path, name, "keep.txt"), "another run\n");
      }

      const run = startSignalChild(CHILD, [project.path], temporaryRoot.path);
      let code;
      let exitSignal;
      /** @type {string[]} */
      let created = [];
      try {
        assert.equal(await run.nextLine(), "ready");
        created = (await readdir(temporaryRoot.path)).filter((name) => !ANOTHER_RUN.includes(name));
        assert.deepEqual(
          created.map((name) => name.replace(/[^-]+$/, "")).sort(),
          ["calavera-artifact-stage-", "calavera-locked-artifact-"],
          "the dry run rebuilds the locked package and stages the unlocked one",
        );
        run.child.kill(signal);
        [code, exitSignal] = await run.exited();
      } finally {
        run.stop();
      }

      assert.equal(code, null);
      assert.equal(exitSignal, signal, "the process still ends by the signal it received");
      for (const name of created) {
        await assert.rejects(stat(join(temporaryRoot.path, name)), { code: "ENOENT" }, name);
      }
      for (const name of ANOTHER_RUN) {
        assert.equal(
          (await stat(join(temporaryRoot.path, name, "keep.txt"))).isFile(),
          true,
          `${name} survives`,
        );
      }
    },
  );
}
