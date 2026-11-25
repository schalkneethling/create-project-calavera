// Tests for temporaryFolder, the helper that creates a test's temporary folder and registers its
// removal in one call (#1076).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { removeTemporaryFolder, temporaryFolder } from "./temporary-folder.mjs";

const execFileAsync = promisify(execFile);
const helperUrl = new URL("./temporary-folder.mjs", import.meta.url).href;

/** @param {string} path */
async function exists(path) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** A stand-in for a test context that records the hooks registered on it. */
function recordingContext() {
  /** @type {(() => Promise<void>)[]} */
  const hooks = [];
  return { hooks, after: (/** @type {() => Promise<void>} */ hook) => hooks.push(hook) };
}

test("the folder is new, in the system temporary folder, and named with the prefix", async (t) => {
  const folder = await temporaryFolder(t, "calavera-temporary-folder-");

  assert.equal(dirname(folder), tmpdir());
  assert.match(basename(folder), /^calavera-temporary-folder-[A-Za-z0-9]{6}$/);
  assert.equal((await stat(folder)).isDirectory(), true);
});

test("the removal is registered before the folder is returned, and removes the folder", async () => {
  const context = recordingContext();
  const folder = await temporaryFolder(context, "calavera-temporary-folder-");
  await writeFile(join(folder, "file.txt"), "content");

  assert.equal(context.hooks.length, 1);
  await context.hooks[0]?.();
  assert.equal(await exists(folder), false);
});

test("a folder a test made read-only is removed with everything in it", async (t) => {
  const context = recordingContext();
  // The outer removal runs even if this test fails before its own hook does.
  t.after(() => Promise.all(context.hooks.map((hook) => hook())));
  const folder = await temporaryFolder(context, "calavera-temporary-folder-");
  const locked = join(folder, "packages", "locked");
  await mkdir(locked, { recursive: true });
  await writeFile(join(locked, "file.txt"), "content");
  await chmod(locked, 0o500);
  await chmod(join(folder, "packages"), 0o500);

  await context.hooks[0]?.();
  assert.equal(await exists(folder), false);
});

test("permissions are restored without following a link to a folder outside", async (t) => {
  const outside = await temporaryFolder(t, "calavera-temporary-folder-outside-");
  await chmod(outside, 0o500);
  const context = recordingContext();
  t.after(() => Promise.all(context.hooks.map((hook) => hook())));
  const folder = await temporaryFolder(context, "calavera-temporary-folder-");
  await symlink(outside, join(folder, "link"));
  await mkdir(join(folder, "locked"));
  await chmod(join(folder, "locked"), 0o500);
  await chmod(folder, 0o500);

  await context.hooks[0]?.();
  assert.equal(await exists(folder), false);
  assert.equal((await stat(outside)).mode & 0o777, 0o500);
});

test("removing a folder that is already gone succeeds", async () => {
  const context = recordingContext();
  const folder = await temporaryFolder(context, "calavera-temporary-folder-");
  await removeTemporaryFolder(folder);

  await removeTemporaryFolder(folder);
  assert.equal(await exists(folder), false);
});

test("a test that fails part way still removes its folder", async (t) => {
  const fixtures = await temporaryFolder(t, "calavera-temporary-folder-fixture-");
  const testFile = join(fixtures, "fails.test.mjs");
  await writeFile(
    testFile,
    [
      `import test from "node:test";`,
      `import { temporaryFolder } from ${JSON.stringify(helperUrl)};`,
      `test("fails after it creates a folder", async (t) => {`,
      `  const folder = await temporaryFolder(t, "calavera-temporary-folder-failing-");`,
      `  console.log("FOLDER=" + folder);`,
      `  throw new Error("this test fails on purpose");`,
      `});`,
    ].join("\n"),
  );

  // NODE_TEST_CONTEXT makes a nested runner report to this one instead of exiting with its result.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const failure = await execFileAsync(
    process.execPath,
    ["--test", "--test-reporter=tap", testFile],
    {
      cwd: fixtures,
      env,
    },
  ).then(
    () => assert.fail("the fixture test was expected to fail"),
    (/** @type {{ code: number, stdout: string }} */ error) => error,
  );

  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /this test fails on purpose/);
  const folder = failure.stdout.match(/FOLDER=(\S+)/)?.[1];
  assert.ok(folder, "the fixture test printed its folder");
  assert.equal(await exists(folder), false);
});
