// Issue #619: each way an artifact transaction is refused has its own message,
// so distinct failures stay distinguishable.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { commitArtifactTransaction } from "../src/artifact-lifecycle.js";

/**
 * Runs `callback` in a new temporary project that has one staged file,
 * `.calavera/.transactions/t/staged.txt`.
 *
 * @param {(paths: { project: string, root: string, staged: string }) => Promise<void>} callback
 */
async function inTransactionProject(callback) {
  const originalDirectory = process.cwd();
  const project = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-")));
  const root = join(project, ".calavera/.transactions/t");
  const staged = join(root, "staged.txt");

  try {
    process.chdir(project);
    await mkdir(root, { recursive: true });
    await writeFile(staged, "staged\n");
    await callback({ project, root, staged });
  } finally {
    process.chdir(originalDirectory);
    await rm(project, { force: true, recursive: true });
  }
}

test("an artifact transaction refuses each invalid operation with its own message and moves nothing", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = join(project, "..", "outside.txt");
    const cases = [
      {
        root: join(project, ".calavera/elsewhere"),
        operations: [{ staged, target: join(project, "a.txt") }],
        message: `The artifact transaction root ${join(project, ".calavera/elsewhere")} is outside ${join(project, ".calavera/.transactions")}.`,
      },
      {
        root,
        operations: [{ staged: join(project, "package.json"), target: join(project, "a.txt") }],
        message: `Artifact transaction operation 0 stages ${join(project, "package.json")}, which is outside the transaction root ${root}.`,
      },
      {
        root,
        operations: [{ staged, target: outside }],
        message: `Artifact transaction operation 0 targets ${outside}, which is outside the project ${project}.`,
      },
      {
        root,
        operations: [
          { staged, target: join(project, "a.txt") },
          { staged, target: join(project, "b.txt") },
          { staged, target: join(project, "a.txt") },
        ],
        message: `Artifact transaction operations 0 and 2 both target ${join(project, "a.txt")}.`,
      },
      {
        root,
        operations: [{ staged: join(root, "missing.txt"), target: join(project, "a.txt") }],
        message: `Artifact transaction operation 0 stages ${join(root, "missing.txt")}, which does not exist.`,
      },
    ];

    const messages = [];
    for (const { root: transactionRoot, operations, message } of cases) {
      await assert.rejects(commitArtifactTransaction(transactionRoot, operations), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, message);
        messages.push(error.message);
        return true;
      });
    }

    assert.equal(new Set(messages).size, cases.length);
    assert.deepEqual((await readdir(project)).sort(), [".calavera"]);
    assert.deepEqual(await readdir(join(project, ".calavera")), [".transactions"]);
  });
});
