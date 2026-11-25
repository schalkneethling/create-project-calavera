// Tests for the check that fails `pnpm quality` when its steps leave `calavera-*` temporary
// folders behind (#1076).
import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { checkTemporaryFolders, leftoverReport } from "./check-temporary-folders.mjs";
import { temporaryFolder } from "./temporary-folder.mjs";

/**
 * A command that runs `code` in a new Node.js process, whose os.tmpdir() is the run's folder.
 * @param {string} code
 * @returns {[string, string[]]}
 */
function node(code) {
  return [
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { mkdir, mkdtemp, chmod, writeFile } from "node:fs/promises";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       ${code}`,
    ],
  ];
}

/** @param {string} path */
async function exists(path) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

test("a command that leaves calavera-* folders is reported, and other entries are not", async () => {
  const result = await checkTemporaryFolders([
    node(`await mkdtemp(join(tmpdir(), "calavera-leaky-"));
          await mkdtemp(join(tmpdir(), "calavera-leaky-"));
          await mkdtemp(join(tmpdir(), "node-compile-cache-"));
          await writeFile(join(tmpdir(), "calavera-file"), "");`),
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.leftovers.length, 3);
  assert.match(result.leftovers[0] ?? "", /^calavera-file$/);
  assert.match(result.leftovers[1] ?? "", /^calavera-leaky-[A-Za-z0-9]{6}$/);
  assert.equal(
    leftoverReport(result.leftovers),
    [
      "The run left 3 calavera-* temporary entries behind, so a test or script does not remove what it creates when it ends:",
      "  calavera-file* (1)",
      "  calavera-leaky-* (2)",
      "Create test folders with temporaryFolder from scripts/temporary-folder.mjs, which removes each folder when its test ends, pass or fail.",
    ].join("\n"),
  );
});

test("a run whose commands remove what they create reports nothing", async () => {
  const result = await checkTemporaryFolders([
    node(`const { rm } = await import("node:fs/promises");
          await rm(await mkdtemp(join(tmpdir(), "calavera-tidy-")), { recursive: true });`),
    node(`await mkdtemp(join(tmpdir(), "playwright-transform-cache-"));`),
  ]);

  assert.deepEqual(result, { exitCode: 0, leftovers: [] });
});

test("calavera-* folders that other runs create in the system temporary folder are not counted", async (t) => {
  // Stands for a folder that a concurrent run or another session made during this run.
  const other = await temporaryFolder(t, "calavera-other-run-");

  const result = await checkTemporaryFolders([node(`process.stdout.write("");`)]);

  assert.deepEqual(result.leftovers, []);
  assert.equal(await exists(other), true);
});

test("the run's folder is removed, even when a command left a read-only folder in it", async (t) => {
  const record = await temporaryFolder(t, "calavera-check-record-");
  const result = await checkTemporaryFolders([
    node(`const folder = await mkdtemp(join(tmpdir(), "calavera-locked-"));
          await mkdir(join(folder, "locked"));
          await chmod(join(folder, "locked"), 0o500);
          await chmod(folder, 0o500);
          await writeFile(${JSON.stringify(join(record, "run-folder"))}, tmpdir());`),
  ]);
  const runFolder = await readFile(join(record, "run-folder"), "utf8");

  assert.equal(result.leftovers.length, 1);
  assert.match(basename(runFolder), /^calavera-test-run-[A-Za-z0-9]{6}$/);
  assert.equal(await exists(runFolder), false);
});

test("the first failing command stops the run with its exit code, and leftovers are still reported", async () => {
  const result = await checkTemporaryFolders([
    node(`await mkdtemp(join(tmpdir(), "calavera-before-failure-")); process.exit(3);`),
    node(`await mkdtemp(join(tmpdir(), "calavera-never-runs-"));`),
  ]);

  assert.equal(result.exitCode, 3);
  assert.equal(result.leftovers.length, 1);
  assert.match(result.leftovers[0] ?? "", /^calavera-before-failure-/);
});
