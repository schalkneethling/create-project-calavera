// Issue #619: each way an artifact transaction is refused has its own message,
// so distinct failures stay distinguishable.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TRANSACTION_PATH,
  commitArtifactTransaction,
  recoverArtifactTransaction,
} from "../src/artifact-lifecycle.js";

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

// Issue #1026: the transaction's checks share `isPathInside`, which keeps the strictest rule of the
// helpers it replaced. A target in a sibling folder whose name starts with the project's name, or
// one whose name starts with `..`, is refused before anything moves.
test("an artifact transaction refuses a target in a look-alike sibling folder or named with a leading `..`", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    for (const target of [`${project}-two/a.txt`, join(project, "..a.txt")]) {
      await assert.rejects(commitArtifactTransaction(root, [{ staged, target }]), {
        message: `Artifact transaction operation 0 targets ${target}, which is outside the project ${project}.`,
      });
    }
    assert.deepEqual((await readdir(project)).sort(), [".calavera"]);
  });
});

// Issue #1026: the rollback of an interrupted transaction checks each journal path with
// `isPathInside` before it moves anything, so a journal that names a path outside the transaction
// root or the project is refused, and the journal and the project stay as they were.
test("recovery refuses a journal whose root or paths leave their workspace and changes nothing", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = join(project, "..", "outside.txt");
    const lookAlike = `${project}-two/a.txt`;
    const valid = { staged, target: join(project, "a.txt"), backup: join(root, "backup.txt") };
    const cases = [
      {
        root: join(project, ".calavera/elsewhere"),
        operation: valid,
        message: "Invalid artifact transaction root.",
      },
      {
        root: join(project, ".calavera/..transactions"),
        operation: valid,
        message: "Invalid artifact transaction root.",
      },
      ...[
        { staged: join(project, "package.json") },
        { staged: join(root, "..staged.txt") },
        { backup: join(project, "backup.txt") },
        { backup: join(root, "..backup.txt") },
        { target: outside },
        { target: lookAlike },
        { target: join(project, "..a.txt") },
      ].map((change) => ({
        root,
        operation: { ...valid, ...change },
        message: "Artifact transaction journal path escapes its workspace.",
      })),
    ];

    for (const { root: transactionRoot, operation, message } of cases) {
      const journal = `${JSON.stringify({
        schemaVersion: 1,
        transactionRoot,
        operations: [{ ...operation, hadTarget: false }],
      })}\n`;
      await writeFile(TRANSACTION_PATH, journal);
      await assert.rejects(recoverArtifactTransaction(), { message }, JSON.stringify(operation));
      assert.equal(await readFile(TRANSACTION_PATH, "utf8"), journal);
    }

    assert.deepEqual((await readdir(project)).sort(), [".calavera"]);
    assert.deepEqual(await readFile(staged, "utf8"), "staged\n");
  });
});

test("recovery with a journal whose paths stay inside rolls back and removes the journal", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    await writeFile(
      TRANSACTION_PATH,
      JSON.stringify({
        schemaVersion: 1,
        transactionRoot: root,
        operations: [
          {
            staged,
            target: join(project, "a.txt"),
            backup: join(root, "backup.txt"),
            hadTarget: false,
          },
        ],
      }),
    );

    await recoverArtifactTransaction();

    assert.deepEqual(await readdir(join(project, ".calavera")), [".transactions"]);
    assert.deepEqual(await readdir(project), [".calavera"]);
  });
});
