// Issue #988: the temporary folders apply rebuilds and stages artifacts in are each removed, even
// when removing another fails, and a failed removal never hides the failure that stopped apply.
import assert from "node:assert/strict";
import test from "node:test";

import fsPromises, { mkdtempDisposable, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CleanupError,
  TemporaryFolderError,
  cleanupFailures,
  errorAfterCleanups,
  errorWithLeftovers,
  removeTemporaryFolder,
  runCleanups,
  temporaryFolderLeftoverLine,
  temporaryFolderLeftovers,
} from "../src/utils/cleanup.js";

test("runCleanups runs every cleanup when an earlier one fails, and lists each failure once", async () => {
  const busy = new Error("EBUSY: resource busy");
  const denied = new Error("EACCES: permission denied");
  let laterRan = false;

  await assert.rejects(
    runCleanups([
      () => Promise.reject(busy),
      // A nested cleanup's failures join the outer list instead of nesting.
      () => runCleanups([() => Promise.reject(denied)]),
      async () => {
        laterRan = true;
      },
    ]),
    (/** @type {unknown} */ error) => {
      assert.ok(error instanceof CleanupError);
      assert.deepEqual(error.errors, [busy, denied]);
      assert.match(error.message, /EBUSY: resource busy EACCES: permission denied/);
      return true;
    },
  );
  assert.equal(laterRan, true);
});

test("runCleanups resolves when every cleanup succeeds", async () => {
  await runCleanups([async () => {}, async () => {}]);
});

test("errorAfterCleanups returns the original error itself when every cleanup succeeds", async () => {
  const stopped = new Error("formatter failed");
  let ran = false;

  const result = await errorAfterCleanups(stopped, [
    async () => {
      ran = true;
    },
  ]);

  assert.equal(result, stopped);
  assert.equal(ran, true);
});

test("errorAfterCleanups keeps the original error first and as the cause when a cleanup fails", async () => {
  const stopped = new Error("formatter failed");
  const busy = new Error("EBUSY: resource busy");
  let laterRan = false;

  const result = await errorAfterCleanups(stopped, [
    () => Promise.reject(busy),
    async () => {
      laterRan = true;
    },
  ]);

  assert.ok(result instanceof AggregateError);
  assert.deepEqual(result.errors, [stopped, busy]);
  assert.equal(result.cause, stopped);
  assert.match(
    result.message,
    /^formatter failed Removing Calavera's temporary folders also failed: EBUSY: resource busy$/,
  );
  assert.equal(laterRan, true);
});

test("a cleanup that throws instead of rejecting neither skips later cleanups nor hides the original error", async () => {
  const stopped = new Error("formatter failed");
  const busy = new Error("EBUSY: resource busy");
  let laterRan = false;

  const result = await errorAfterCleanups(stopped, [
    () => {
      throw busy;
    },
    async () => {
      laterRan = true;
    },
  ]);

  assert.ok(result instanceof AggregateError);
  assert.deepEqual(result.errors, [stopped, busy]);
  assert.equal(laterRan, true);
});

// Issue #1033: after a command has done its work, a temporary folder it cannot remove is reported,
// not thrown.

test("removeTemporaryFolder removes the folder and everything in it, and accepts a missing folder", async () => {
  await using parent = await mkdtempDisposable(join(tmpdir(), "calavera-remove-folder-"));
  const folder = join(parent.path, "temporary");
  await fsPromises.mkdir(join(folder, "nested"), { recursive: true });
  await writeFile(join(folder, "nested", "file.txt"), "text\n");

  await removeTemporaryFolder(folder);
  await removeTemporaryFolder(folder);

  await assert.rejects(stat(folder), { code: "ENOENT" });
});

test("removeTemporaryFolder names the folder and the code, never the message, and keeps the cause", async (t) => {
  const busy = Object.assign(new Error("EBUSY: secret text, rmdir '/folder/inner'"), {
    code: "EBUSY",
    path: "/folder/inner",
  });
  t.mock.method(fsPromises, "rm", () => Promise.reject(busy));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  await assert.rejects(removeTemporaryFolder("/folder"), (/** @type {unknown} */ error) => {
    assert.ok(error instanceof TemporaryFolderError);
    assert.equal(error.message, "Could not remove /folder (EBUSY).");
    assert.equal(error.path, "/folder");
    assert.equal(error.code, "EBUSY");
    assert.equal(error.cause, busy);
    return true;
  });
});

test("a TemporaryFolderError without a string code leaves the code out", () => {
  for (const cause of [new Error("no code"), { code: 42 }, undefined, null]) {
    const error = new TemporaryFolderError("/folder", cause);

    assert.equal(error.message, "Could not remove /folder.");
    assert.equal(error.code, undefined);
    assert.equal(error.cause, cause);
  }
});

test("temporaryFolderLeftovers names each folder left with its code, never a message", async () => {
  let laterRan = false;

  const failures = await cleanupFailures([
    () => Promise.reject(new TemporaryFolderError("/one", { code: "EBUSY" })),
    // A nested cleanup's failures join the list.
    () => runCleanups([() => Promise.reject(new TemporaryFolderError("/two", {}))]),
    () => Promise.reject(Object.assign(new Error("secret text"), { code: "EPERM" })),
    async () => {
      laterRan = true;
    },
  ]);

  assert.equal(laterRan, true);
  assert.deepEqual(temporaryFolderLeftovers(failures), [
    {
      path: "/one",
      reason:
        "Calavera could not remove this temporary folder (EBUSY). Nothing in the project uses it, so remove it yourself.",
    },
    {
      path: "/two",
      reason:
        "Calavera could not remove this temporary folder. Nothing in the project uses it, so remove it yourself.",
    },
    {
      path: "",
      reason:
        "Calavera could not remove one of its temporary folders (EPERM). Look for a calavera- folder in the system's temporary folder or in .calavera/.transactions/, and remove it.",
    },
  ]);
  assert.deepEqual(temporaryFolderLeftovers([]), []);
  // A cleanup can reject with no error at all.
  assert.deepEqual(temporaryFolderLeftovers([undefined]), [
    {
      path: "",
      reason:
        "Calavera could not remove one of its temporary folders. Look for a calavera- folder in the system's temporary folder or in .calavera/.transactions/, and remove it.",
    },
  ]);
});

test("temporaryFolderLeftovers says when a folder left is inside the project, which Git does not ignore", () => {
  const inside = join(process.cwd(), ".calavera", ".transactions", "1-2");

  assert.deepEqual(
    temporaryFolderLeftovers([new TemporaryFolderError(inside, { code: "EBUSY" })]),
    [
      {
        path: inside,
        reason:
          "Calavera could not remove this temporary folder (EBUSY). Nothing in the project uses it, so remove it yourself. It is inside the project and Git does not ignore it, so remove it before you commit.",
      },
    ],
  );
});

test("errorWithLeftovers returns the error itself when no folder was left", () => {
  const stopped = new Error("write failed");

  assert.equal(errorWithLeftovers(stopped, []), stopped);
});

test("errorWithLeftovers keeps the error first and as the cause, and names each folder left", () => {
  const stopped = new Error("write failed");
  const left = new TemporaryFolderError("/one", { code: "EBUSY" });

  const result = errorWithLeftovers(stopped, [left]);

  assert.ok(result instanceof AggregateError);
  assert.deepEqual(result.errors, [stopped, left]);
  assert.equal(result.cause, stopped);
  assert.equal(
    result.message,
    "write failed\nNot removed /one: Calavera could not remove this temporary folder (EBUSY). Nothing in the project uses it, so remove it yourself.",
  );
});

test("temporaryFolderLeftoverLine names the folder when there is one", () => {
  assert.equal(
    temporaryFolderLeftoverLine({ path: "/one", reason: "Why." }),
    "Not removed /one: Why.",
  );
  assert.equal(temporaryFolderLeftoverLine({ path: "", reason: "Why." }), "Not removed: Why.");
});
