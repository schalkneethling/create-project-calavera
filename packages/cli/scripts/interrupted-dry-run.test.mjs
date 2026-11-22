// Issue #1081: a dry run that Ctrl+C (SIGINT) or SIGTERM interrupts removes the temporary folders
// it created, by their exact paths, and leaves every other folder in the system's temporary
// folder alone, including another run's folder with the same prefix.
import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtempDisposable, readdir, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TemporaryFolderError,
  createTemporaryFolder,
  removeTemporaryFolder,
} from "../src/utils/cleanup.js";
import { startSignalChild } from "./signal-child.mjs";

const CHILD = fileURLToPath(new URL("./interrupted-dry-run-child.mjs", import.meta.url));
const ANOTHER_RUN = ["calavera-locked-artifact-another-run", "calavera-artifact-stage-another-run"];

/**
 * Makes `folder` the system's temporary folder for the rest of test `t`: os.tmpdir() reads TMPDIR
 * on Linux and macOS, and TEMP and TMP on Windows.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} folder
 */
function useSystemTemporaryFolder(t, folder) {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    const previous = process.env[name];
    process.env[name] = folder;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

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

test("the interrupt handlers stay attached only while a temporary folder exists", async (t) => {
  // The folders go into a folder the test owns, so disposing it removes them whatever the outcome.
  await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
  useSystemTemporaryFolder(t, owned.path);
  const before = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };

  const first = await createTemporaryFolder("calavera-locked-artifact-");
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1, "the first folder attaches it");
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);
  const second = await createTemporaryFolder("calavera-locked-artifact-");
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1);
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);

  await removeTemporaryFolder(first);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1, "a folder still exists");

  await removeTemporaryFolder(second);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
  assert.equal(
    first.startsWith(owned.path),
    true,
    "the folder is in the system's temporary folder",
  );
  await assert.rejects(stat(first), { code: "ENOENT" });
  await assert.rejects(stat(second), { code: "ENOENT" });
});

test("a folder whose removal failed stays recorded, so the interrupt handlers stay attached for it", async (t) => {
  await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
  useSystemTemporaryFolder(t, owned.path);
  const remove = fsPromises.rm;
  const busy = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
  let failRemoval = true;
  t.mock.method(
    fsPromises,
    "rm",
    (/** @type {string} */ path, /** @type {import("node:fs").RmOptions} */ rmOptions) =>
      failRemoval ? Promise.reject(busy) : remove(path, rmOptions),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const before = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };

  const folder = await createTemporaryFolder("calavera-locked-artifact-");
  await assert.rejects(removeTemporaryFolder(folder), TemporaryFolderError);

  assert.equal((await stat(folder)).isDirectory(), true);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1, "the folder is still recorded");
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);

  failRemoval = false;
  await removeTemporaryFolder(folder);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
});
