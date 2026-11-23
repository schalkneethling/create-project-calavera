// Issue #619: each way an artifact transaction is refused has its own message,
// so distinct failures stay distinguishable.
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import {
  TRANSACTION_PATH,
  commitArtifactTransaction,
  isTransactionTarget,
  recoverArtifactTransaction,
  rollBackArtifactOperations,
  writtenFingerprint,
} from "../src/artifact-lifecycle.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

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
    const skill = join(project, ".agents/skills/a");
    const cases = [
      {
        root: join(project, ".calavera/elsewhere"),
        operations: [{ staged, target: skill }],
        message: `The artifact transaction root ${join(project, ".calavera/elsewhere")} is outside ${join(project, ".calavera/.transactions")}.`,
      },
      {
        root,
        operations: [{ staged: join(project, "package.json"), target: skill }],
        message: `Artifact transaction operation 0 stages ${join(project, "package.json")}, which is outside the transaction root ${root}.`,
      },
      {
        root,
        operations: [{ staged, target: outside }],
        message: `Artifact transaction operation 0 targets ${outside}, which is outside the project ${project}.`,
      },
      {
        root,
        operations: [{ staged, target: join(project, "package.json") }],
        message: `Artifact transaction operation 0 targets ${join(project, "package.json")}, which is not a path an artifact transaction writes.`,
      },
      {
        root,
        operations: [
          { staged, target: skill },
          { staged, target: join(project, ".agents/skills/b") },
          { staged, target: skill },
        ],
        message: `Artifact transaction operations 0 and 2 both target ${skill}.`,
      },
      {
        root,
        operations: [
          { staged, target: join(project, ".agents/skills/a/inner") },
          { staged, target: join(project, ".agents/skills/b") },
          { staged, target: skill },
        ],
        message: `Artifact transaction operations 0 and 2 target ${join(project, ".agents/skills/a/inner")} and ${skill}, the same path or one inside the other.`,
      },
      {
        root,
        operations: [
          { staged, target: skill },
          { staged, target: join(project, ".agents/skills/A") },
        ],
        message: `Artifact transaction operations 0 and 1 target ${skill} and ${join(project, ".agents/skills/A")}, the same path or one inside the other.`,
      },
      {
        root,
        operations: [{ staged: join(root, "missing.txt"), target: skill }],
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

// Issue #1026: the transaction's checks share `isPathInside`. A target in a sibling folder whose
// name starts with the project's name is refused before anything moves.
test("an artifact transaction refuses a target in a look-alike sibling folder", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    for (const target of [`${project}-two/a.txt`]) {
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
    const valid = {
      staged,
      target: join(project, ".agents/skills/a"),
      backup: join(root, "backup.txt"),
    };
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
        { backup: join(project, "backup.txt") },
        { target: outside },
        { target: lookAlike },
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

// A name that starts with `..`, such as `..a.txt`, is a file in its folder (#1026), so a journal
// that uses such names for its staged, backup, and target paths is rolled back like any other.
for (const names of [
  { staged: "staged.txt", backup: "backup.txt", target: "a" },
  { staged: "..staged.txt", backup: "..backup.txt", target: "..a" },
]) {
  test(`recovery with a journal whose paths stay inside rolls back and removes the journal (${names.target})`, async () => {
    await inTransactionProject(async ({ project, root }) => {
      const staged = join(root, names.staged);
      await writeFile(staged, "staged\n");
      const target = join(project, ".agents/skills", names.target);
      await mkdir(join(project, ".agents/skills"), { recursive: true });
      await writeFile(target, "half-moved\n");
      await writeFile(
        TRANSACTION_PATH,
        JSON.stringify({
          schemaVersion: 1,
          transactionRoot: root,
          operations: [
            {
              staged,
              target,
              backup: join(root, names.backup),
              hadTarget: false,
              writtenHash: await writtenFingerprint(target),
            },
          ],
        }),
      );

      await recoverArtifactTransaction();

      assert.deepEqual(await readdir(join(project, ".calavera")), [".transactions"]);
      assert.deepEqual(await readdir(join(project, ".agents/skills")), []);
    });
  });
}

test("an artifact transaction moves a staged file to a target whose name starts with `..`", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const target = join(project, ".agents/skills/..a");
    await commitArtifactTransaction(root, [{ staged, target }]);
    assert.equal(await readFile(target, "utf8"), "staged\n");
  });
});

// #1092: a commit that fails part way leaves the journal it wrote before moving anything, and
// recovery rolls the project back from that journal alone. The test reads the journal the commit
// wrote, not one the test wrote, so emptying or changing it fails here.
test("a commit that fails part way leaves a journal of every operation, and recovery rolls back from it", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const skills = join(project, ".agents/skills");
    await mkdir(skills, { recursive: true });
    const replaced = join(skills, "replaced");
    await writeFile(replaced, "before\n");
    const created = join(root, "created.txt");
    await writeFile(created, "created\n");
    // The third operation stages the file the first one moves, so it exists when the commit
    // checks it and is gone when its move runs, after the first two moved.
    const operations = [
      { staged, target: replaced },
      { staged: created, target: join(skills, "created") },
      { staged, target: join(skills, "never") },
    ];

    const writtenHashes = [
      await writtenFingerprint(staged),
      await writtenFingerprint(created),
      await writtenFingerprint(staged),
    ];

    await assert.rejects(commitArtifactTransaction(root, operations), { code: "ENOENT" });

    assert.deepEqual(JSON.parse(await readFile(TRANSACTION_PATH, "utf8")), {
      schemaVersion: 1,
      transactionRoot: root,
      operations: operations.map((operation, index) => ({
        ...operation,
        backup: join(root, "backups", String(index)),
        hadTarget: index === 0,
        writtenHash: writtenHashes[index],
      })),
    });
    assert.equal(await readFile(replaced, "utf8"), "staged\n");

    await recoverArtifactTransaction();

    assert.equal(await readFile(replaced, "utf8"), "before\n");
    assert.deepEqual(await readdir(skills), ["replaced"]);
    assert.deepEqual(await readdir(join(project, ".calavera")), [".transactions"]);
  });
});

// The end of each message that stops the rollback part way, for a journal whose operations up to
// and including operation 0 are left.
const STOPPED_REMEDY =
  "Calavera does not roll the rest of this journal back. A symbolic link on the way may be one the rollback moved into place from a backup, so replace every link on the paths of the targets of operations 0 to 0 with a real folder before you restore those files by hand from the backups in .calavera/.transactions, then remove .calavera/artifact-transaction.json.";

const REMEDY =
  "Calavera does not roll this journal back. Restore the files it names by hand if needed, using the backups in .calavera/.transactions, then remove .calavera/artifact-transaction.json.";

/**
 * Writes a pending journal with one operation per entry of `operations`, each given as absolute
 * paths, and returns the journal text.
 *
 * @param {string} transactionRoot
 * @param {{ staged: string, target: string, backup: string, hadTarget: boolean, writtenHash?: string }[]} operations
 */
async function writeJournal(transactionRoot, operations) {
  const journal = `${JSON.stringify({ schemaVersion: 1, transactionRoot, operations })}\n`;
  await writeFile(TRANSACTION_PATH, journal);
  return journal;
}

// #1193: recovery refuses a journal whose target is the project root, a parent folder, a path no
// transaction writes, or a path below a symbolic link, each with its own message, before it moves
// anything. Each journal would otherwise make the rollback remove or replace files the transaction
// never wrote, inside the project or, through a link, outside it. The project and the folder the
// links point to stay byte-identical, and the journal stays for a later recovery.
test("recovery refuses a journal that targets the root, a parent folder, an unlisted path, or a linked folder, and changes nothing", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-outside-")));
    try {
      await writeFile(join(project, "package.json"), "{}\n");
      await mkdir(join(project, ".calavera/.transactions/t/backups"), { recursive: true });
      // `.agents` links to a folder outside the project that holds a skill.
      await mkdir(join(outside, "agents/skills/x"), { recursive: true });
      await writeFile(join(outside, "agents/skills/x/SKILL.md"), "# Outside\n");
      await symlink(join(outside, "agents"), join(project, ".agents"));
      // A transaction root below a link to an outside folder.
      await mkdir(join(outside, "transactions/inner"), { recursive: true });
      await writeFile(join(outside, "transactions/inner/keep.txt"), "keep\n");
      await symlink(join(outside, "transactions"), join(project, ".calavera/.transactions/linked"));
      // A backups folder that links to an outside folder.
      await mkdir(join(outside, "backups"), { recursive: true });
      await writeFile(join(outside, "backups/0"), "outside backup\n");
      const linkedRoot = join(project, ".calavera/.transactions/b");
      // A backup that is itself a link to an outside folder that holds `victim`.
      await mkdir(join(outside, "nested/victim"), { recursive: true });
      await symlink(join(outside, "nested"), join(root, "backups/outside"));
      await mkdir(linkedRoot);
      await symlink(join(outside, "backups"), join(linkedRoot, "backups"));

      const backup = join(root, "backups/0");
      const operation = (/** @type {string} */ target) => ({
        staged,
        target,
        backup,
        hadTarget: false,
      });
      const notWritten = (/** @type {string} */ path) =>
        `Artifact transaction journal operation 0 targets ${path}, which is not a path an artifact transaction writes. ${REMEDY}`;
      const cases = [
        {
          root,
          operations: [operation(project)],
          message: notWritten("the project root"),
        },
        {
          root,
          operations: [operation(join(project, ".."))],
          message: "Artifact transaction journal path escapes its workspace.",
        },
        {
          root,
          operations: [operation(join(project, ".calavera"))],
          message: notWritten(".calavera"),
        },
        {
          root,
          operations: [operation(join(project, ".calavera/packages"))],
          message: notWritten(".calavera/packages"),
        },
        {
          root,
          operations: [operation(join(project, "package.json"))],
          message: notWritten("package.json"),
        },
        {
          root,
          operations: [operation(join(project, ".agents/skills/x"))],
          message: `Artifact transaction journal path .agents/skills/x lies below the symbolic link .agents. ${REMEDY}`,
        },
        {
          root: join(project, ".calavera/.transactions/linked/inner"),
          operations: [],
          message: `Artifact transaction journal path .calavera/.transactions/linked/inner lies below the symbolic link .calavera/.transactions/linked. ${REMEDY}`,
        },
        {
          root: linkedRoot,
          operations: [
            {
              staged: join(linkedRoot, "staged"),
              target: join(project, ".codex/agents/y.toml"),
              backup: join(linkedRoot, "backups/0"),
              hadTarget: true,
            },
          ],
          message: `Artifact transaction journal path .calavera/.transactions/b/backups/0 lies below the symbolic link .calavera/.transactions/b/backups. ${REMEDY}`,
        },
        {
          root,
          operations: [
            operation(join(project, ".codex/agents/a.toml")),
            operation(join(project, ".codex/agents/a.toml")),
          ],
          message: `Artifact transaction journal operations 0 and 1 target .codex/agents/a.toml and .codex/agents/a.toml, the same path or one inside the other. ${REMEDY}`,
        },
        // The backup of the second operation links outside. Rolled back first, it would move the
        // link to .codex/agents/foo, and removing the first target would then follow the link.
        {
          root,
          operations: [
            {
              staged,
              target: join(project, ".codex/agents/foo/victim"),
              backup: join(root, "backups/0"),
              hadTarget: false,
            },
            {
              staged,
              target: join(project, ".codex/agents/foo"),
              backup: join(root, "backups/outside"),
              hadTarget: true,
            },
          ],
          message: `Artifact transaction journal operations 0 and 1 target .codex/agents/foo/victim and .codex/agents/foo, the same path or one inside the other. ${REMEDY}`,
        },
      ];

      const projectBefore = await snapshotDirectory(project);
      const outsideBefore = await snapshotDirectory(outside);
      for (const { root: transactionRoot, operations, message } of cases) {
        const journal = await writeJournal(transactionRoot, operations);
        const projectWithJournal = await snapshotDirectory(project);
        await assert.rejects(recoverArtifactTransaction(), { message }, message);
        assert.deepEqual(await snapshotDirectory(project), projectWithJournal, message);
        assert.equal(await readFile(TRANSACTION_PATH, "utf8"), journal);
        await rm(TRANSACTION_PATH);
        assert.deepEqual(await snapshotDirectory(project), projectBefore, message);
        assert.deepEqual(await snapshotDirectory(outside), outsideBefore, message);
      }
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

// #1193: every path the two journal writers target is accepted, so each entry of the allowed set
// is needed: a file the cache block or the install writes, and a path below each output folder.
test("recovery rolls back each path an artifact transaction writes", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const targets = [
      ".gitignore",
      ".calavera/state.json",
      ".calavera/artifacts.lock.json",
      ".coderabbit.yaml",
      ".calavera/packages/a/1.0.0",
      ".agents/skills/a",
      ".agents/hooks/claude-code/a.mjs",
      ".agents/agents/claude-code/a.md",
      ".codex/agents/a.toml",
    ].map((path) => join(project, path));
    for (const target of targets) {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, "new\n");
    }
    const writtenHash = await writtenFingerprint(targets[0]);
    await writeJournal(
      root,
      targets.map((target, index) => ({
        staged,
        target,
        backup: join(root, "backups", String(index)),
        hadTarget: false,
        writtenHash,
      })),
    );

    await recoverArtifactTransaction();

    for (const target of targets) {
      await assert.rejects(readFile(target), { code: "ENOENT" }, target);
    }
    await assert.rejects(readFile(TRANSACTION_PATH), { code: "ENOENT" });
  });
});

// #1193: when recovery cannot tell whether a folder above a journal path is a symbolic link, it
// stops before it changes anything, even for an operation it could otherwise roll back, with a
// message that names the operation and the remedy and keeps the cause.
// A process that runs as root reads any folder, so the unreadable-folder case cannot fail there.
for (const { name, code, plant, target = ".agents/skills/x", skip = false } of [
  {
    name: "a file stands where a folder would be",
    code: "ENOTDIR",
    plant: async (/** @type {string} */ project) => writeFile(join(project, ".agents"), "file\n"),
  },
  {
    name: "a folder name is too long to check",
    code: "ENAMETOOLONG",
    target: `.agents/skills/${"a".repeat(300)}/x`,
    plant: async (/** @type {string} */ project) =>
      mkdir(join(project, ".agents/skills"), { recursive: true }),
  },
  {
    name: "a folder cannot be read",
    code: "EACCES",
    plant: async (/** @type {string} */ project) => {
      await mkdir(join(project, ".agents/skills/x"), { recursive: true });
      await chmod(join(project, ".agents"), 0o000);
    },
    skip: process.getuid?.() === 0,
  },
]) {
  test(`recovery stops and changes nothing when ${name}`, { skip }, async () => {
    await inTransactionProject(async ({ project, root, staged }) => {
      const created = join(project, ".codex/agents/created.toml");
      await mkdir(join(project, ".codex/agents"), { recursive: true });
      await writeFile(created, "created\n");
      const journal = await writeJournal(root, [
        {
          staged,
          target: join(project, target),
          backup: join(root, "backups/0"),
          hadTarget: false,
        },
        { staged, target: created, backup: join(root, "backups/1"), hadTarget: false },
      ]);
      const before = await snapshotDirectory(project);
      await plant(project);
      try {
        await assert.rejects(recoverArtifactTransaction(), (error) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            `Calavera cannot check artifact transaction journal operation 0, because checking the folders above ${join(target)} for a symbolic link failed with ${code}. ${REMEDY}`,
          );
          assert.equal(/** @type {NodeJS.ErrnoException} */ (error.cause).code, code);
          return true;
        });
      } finally {
        await chmod(join(project, ".agents"), 0o755);
      }
      await rm(join(project, ".agents"), { recursive: true, force: true });
      assert.deepEqual(await snapshotDirectory(project), before);
      assert.equal(await readFile(TRANSACTION_PATH, "utf8"), journal);
    });
  });
}

// #1193: on Windows, paths that differ only in letter case name the same file, so changing the
// case of a target folder does not make it a path below that folder, and a journal written while
// the working folder had other letter case still names the files a transaction writes.
test("the allowed targets compare Windows paths without letter case", () => {
  const root = "C:\\proj";
  assert.equal(isTransactionTarget(root, "c:\\PROJ\\.calavera\\packages", win32), false);
  assert.equal(isTransactionTarget(root, "c:\\PROJ\\.agents\\skills", win32), false);
  assert.equal(isTransactionTarget(root, "c:\\PROJ", win32), false);
  assert.equal(isTransactionTarget(root, "c:\\PROJ\\.gitignore", win32), true);
  assert.equal(isTransactionTarget(root, "c:\\PROJ\\.agents\\skills\\a", win32), true);
});

// #1193 (owner decision of 2026-11-23): the commit and the rollback share one symbolic-link check,
// so the commit refuses, before it writes the journal or moves anything, every layout whose
// journal the rollback would refuse.
for (const { name, link, target } of [
  { name: "a target", link: ".agents", target: ".agents/skills/a" },
  { name: "a target's own folder", link: ".agents/skills", target: ".agents/skills/a" },
  {
    name: "the backups",
    link: ".calavera/.transactions/t/backups",
    target: ".codex/agents/a.toml",
  },
]) {
  test(`the commit and the rollback both refuse a symbolic link above ${name}`, async () => {
    await inTransactionProject(async ({ project, root, staged }) => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-link-")));
      try {
        await mkdir(join(project, link, ".."), { recursive: true });
        await symlink(outside, join(project, link));
        const before = await snapshotDirectory(project);

        await assert.rejects(
          commitArtifactTransaction(root, [{ staged, target: join(project, target) }]),
          {
            message: `Calavera does not write artifacts through the symbolic link ${link}. Replace ${link} with a real folder, then run the command again.`,
          },
        );
        assert.deepEqual(await snapshotDirectory(project), before);
        assert.deepEqual(await readdir(outside), []);

        // The journal the commit would have written.
        await writeJournal(root, [
          {
            staged,
            target: join(project, target),
            backup: join(root, "backups/0"),
            hadTarget: false,
          },
        ]);
        await assert.rejects(recoverArtifactTransaction(), {
          message: new RegExp(`lies below the symbolic link ${link.replaceAll(".", "\\.")}\\. `),
        });
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });
  });
}

// #1193: on a file system that ignores letter case or Unicode normalization, such as the default
// APFS on macOS, `FOO` and `foo`, or `é` and `e` with a combining accent, name the same folder.
// Rolled back in reverse, the second operation would move its linked backup into that folder, and
// removing the first target would then follow the link outside the project. The nested-target
// check compares folded spellings on every platform, so recovery refuses the journal up front.
for (const { name, folder, nested } of [
  { name: "letter case", folder: "FOO", nested: "foo/bar" },
  // Precomposed é against e with a combining acute accent.
  {
    name: "Unicode normalization",
    folder: String.fromCodePoint(0xe9),
    nested: `e${String.fromCodePoint(0x301)}/bar`,
  },
  // Greek alpha with psili and an iota subscript, then an acute accent, against the precomposed
  // letter with all three: canonically equivalent, but the iota subscript folds to a separate ι,
  // so only folding the decomposed form puts the accent in the same place in both.
  {
    name: "Unicode normalization of an iota subscript",
    folder: String.fromCodePoint(0x1f84),
    nested: `${String.fromCodePoint(0x1f80, 0x301)}/bar`,
  },
  // Case folding that APFS applies and lower-casing alone does not: ß against ss, capital sharp s
  // against ss, final sigma against sigma, and the ff ligature against ff.
  { name: "full case folding (sharp s)", folder: String.fromCodePoint(0xdf), nested: "ss/bar" },
  {
    name: "full case folding (capital sharp s)",
    folder: String.fromCodePoint(0x1e9e),
    nested: "ss/bar",
  },
  {
    name: "full case folding (final sigma)",
    folder: String.fromCodePoint(0x3c2),
    nested: `${String.fromCodePoint(0x3c3)}/bar`,
  },
  { name: "full case folding (ligature)", folder: String.fromCodePoint(0xfb00), nested: "ff/bar" },
]) {
  test(`recovery refuses targets that nest only when ${name} is ignored, and changes nothing`, async () => {
    await inTransactionProject(async ({ project, root, staged }) => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-fold-")));
      try {
        await mkdir(join(outside, "bar"));
        await writeFile(join(outside, "bar/keep.txt"), "keep\n");
        await mkdir(join(root, "backups"), { recursive: true });
        await symlink(outside, join(root, "backups/1"));
        await mkdir(join(project, ".agents/skills"), { recursive: true });
        const journal = await writeJournal(root, [
          {
            staged,
            target: join(project, ".agents/skills", nested),
            backup: join(root, "backups/0"),
            hadTarget: false,
          },
          {
            staged,
            target: join(project, ".agents/skills", folder),
            backup: join(root, "backups/1"),
            hadTarget: true,
          },
        ]);
        const projectBefore = await snapshotDirectory(project);
        const outsideBefore = await snapshotDirectory(outside);

        await assert.rejects(recoverArtifactTransaction(), {
          message: `Artifact transaction journal operations 0 and 1 target ${join(".agents/skills", nested)} and ${join(".agents/skills", folder)}, the same path or one inside the other. ${REMEDY}`,
        });

        assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
        assert.deepEqual(await snapshotDirectory(project), projectBefore);
        assert.equal(await readFile(TRANSACTION_PATH, "utf8"), journal);
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });
  });
}

// #1193: the rollback checks a target's folders for a symbolic link again right before each step,
// so a link that an earlier step moved into place stops it, however the journal spells the path.
// The operations go to the loop directly, past the journal checks that would refuse them first.
test("the rollback stops before a step whose folder an earlier step replaced with a link", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-step-")));
    try {
      await mkdir(join(outside, "bar"));
      await writeFile(join(outside, "bar/keep.txt"), "keep\n");
      await mkdir(join(root, "backups"), { recursive: true });
      await symlink(outside, join(root, "backups/1"));
      await mkdir(join(project, ".agents/skills"), { recursive: true });
      const outsideBefore = await snapshotDirectory(outside);

      await assert.rejects(
        rollBackArtifactOperations(project, [
          {
            staged,
            target: join(project, ".agents/skills/foo/bar"),
            backup: join(root, "backups/0"),
            hadTarget: false,
          },
          {
            staged,
            target: join(project, ".agents/skills/foo"),
            backup: join(root, "backups/1"),
            hadTarget: true,
          },
        ]),
        {
          message: `The artifact transaction rollback stopped before operation 0, because ${join(".agents/skills/foo/bar")} lies below the symbolic link ${join(".agents/skills/foo")}. It already rolled back operation 1. ${STOPPED_REMEDY}`,
        },
      );

      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

// The rollback removes a folder that the stopped operation created, with its files, restores a
// folder from its backup, and leaves alone a target that existed before but was never backed up,
// because the stopped operation had not moved it yet.
test("the rollback removes created folders, restores backed-up folders, and keeps targets it never moved", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const skills = join(project, ".agents/skills");
    await mkdir(join(skills, "created"), { recursive: true });
    await writeFile(join(skills, "created/SKILL.md"), "# Created\n");
    await mkdir(join(skills, "restored"), { recursive: true });
    await writeFile(join(skills, "restored/SKILL.md"), "# New\n");
    await mkdir(join(root, "backups/1"), { recursive: true });
    await writeFile(join(root, "backups/1/SKILL.md"), "# Before\n");
    await mkdir(join(skills, "kept"));
    await writeFile(join(skills, "kept/SKILL.md"), "# Edited by the person\n");

    await rollBackArtifactOperations(project, [
      {
        staged,
        target: join(skills, "created"),
        backup: join(root, "backups/0"),
        hadTarget: false,
      },
      {
        staged,
        target: join(skills, "restored"),
        backup: join(root, "backups/1"),
        hadTarget: true,
      },
      { staged, target: join(skills, "kept"), backup: join(root, "backups/2"), hadTarget: true },
    ]);

    assert.deepEqual((await readdir(skills)).sort(), ["kept", "restored"]);
    assert.equal(await readFile(join(skills, "restored/SKILL.md"), "utf8"), "# Before\n");
    assert.equal(await readFile(join(skills, "kept/SKILL.md"), "utf8"), "# Edited by the person\n");
  });
});

// #1193: a link the person made at a target, such as a skill folder linked from elsewhere, is not
// refused. The commit backs the link up as a link, and the rollback puts the same link back
// without touching the folder it points to.
test("a target that is itself a symbolic link is committed and rolled back as a link", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-own-")));
    try {
      await writeFile(join(outside, "SKILL.md"), "# Mine\n");
      const target = join(project, ".agents/skills/mine");
      await mkdir(join(project, ".agents/skills"), { recursive: true });
      await symlink(outside, target);
      const outsideBefore = await snapshotDirectory(outside);

      await commitArtifactTransaction(root, [{ staged, target }]);
      assert.equal((await lstat(target)).isSymbolicLink(), false);
      assert.equal((await lstat(join(root, "backups/0"))).isSymbolicLink(), true);

      // The journal the commit wrote, as an interrupted commit would leave it.
      await writeJournal(root, [
        {
          staged,
          target,
          backup: join(root, "backups/0"),
          hadTarget: true,
          writtenHash: await writtenFingerprint(target),
        },
      ]);
      await recoverArtifactTransaction();

      assert.equal(await readlink(target), outside);
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

// When the first step already meets a link, the message says that nothing was rolled back.
test("the rollback names that it rolled back nothing when the first step meets a link", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-first-")));
    try {
      await mkdir(join(project, ".agents"));
      await symlink(outside, join(project, ".agents/skills"));
      await assert.rejects(
        rollBackArtifactOperations(project, [
          {
            staged,
            target: join(project, ".agents/skills/a"),
            backup: join(root, "backups/0"),
            hadTarget: false,
          },
        ]),
        {
          message: `The artifact transaction rollback stopped before operation 0, because ${join(".agents/skills/a")} lies below the symbolic link ${join(".agents/skills")}. It rolled back no operation yet. ${STOPPED_REMEDY}`,
        },
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

// #1193: a step that meets a link stops the rollback when it would restore a backup, as it does
// when it would remove a created target.
test("the rollback stops part way with its remedy before a restore below a link", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-stop-")));
    try {
      const skills = join(project, ".agents/skills");
      await mkdir(skills, { recursive: true });
      await mkdir(join(root, "backups"), { recursive: true });
      await mkdir(join(outside, "bar"));
      await writeFile(join(outside, "bar/keep.txt"), "keep\n");
      await writeFile(join(root, "backups/0"), "backup\n");
      await symlink(outside, join(root, "backups/1"));
      const outsideBefore = await snapshotDirectory(outside);

      await assert.rejects(
        rollBackArtifactOperations(project, [
          {
            staged,
            target: join(skills, "foo/bar"),
            backup: join(root, "backups/0"),
            hadTarget: true,
          },
          { staged, target: join(skills, "foo"), backup: join(root, "backups/1"), hadTarget: true },
        ]),
        {
          message: `The artifact transaction rollback stopped before operation 0, because ${join(".agents/skills/foo/bar")} lies below the symbolic link ${join(".agents/skills/foo")}. It already rolled back operation 1. ${STOPPED_REMEDY}`,
        },
      );
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
      assert.equal(await readFile(join(root, "backups/0"), "utf8"), "backup\n");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

// With several operations rolled back before the stop, the message names the whole range.
test("the rollback names the range of operations it rolled back before it stopped", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-transaction-range-")));
    try {
      const skills = join(project, ".agents/skills");
      await mkdir(skills, { recursive: true });
      await writeFile(join(skills, "other"), "created\n");
      await mkdir(join(root, "backups"), { recursive: true });
      await symlink(outside, join(root, "backups/1"));

      await assert.rejects(
        rollBackArtifactOperations(project, [
          {
            staged,
            target: join(skills, "foo/bar"),
            backup: join(root, "backups/0"),
            hadTarget: false,
          },
          { staged, target: join(skills, "foo"), backup: join(root, "backups/1"), hadTarget: true },
          {
            staged,
            target: join(skills, "other"),
            backup: join(root, "backups/2"),
            hadTarget: false,
          },
        ]),
        {
          message: `The artifact transaction rollback stopped before operation 0, because ${join(".agents/skills/foo/bar")} lies below the symbolic link ${join(".agents/skills/foo")}. It already rolled back operations 1 to 2. ${STOPPED_REMEDY}`,
        },
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

// #1193: Windows strips a trailing space or dot from a path segment, so `.agents/skills/ ` or
// `.agents/skills/x.` would name `.agents/skills` or `.agents/skills/x` there, and removing it
// would remove more than the transaction wrote. Such a target is refused on every platform.
test("a target with a segment that ends in a space or a dot is refused by the commit and by recovery", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    await mkdir(join(project, ".agents/skills/x"), { recursive: true });
    for (const path of [
      ".agents/skills/ ",
      ".agents/skills/x.",
      ".agents/skills/x /y",
      ".calavera/packages/a./1.0.0",
    ]) {
      const target = join(project, path);
      await assert.rejects(commitArtifactTransaction(root, [{ staged, target }]), {
        message: `Artifact transaction operation 0 targets ${target}, which is not a path an artifact transaction writes.`,
      });
      await writeJournal(root, [
        { staged, target, backup: join(root, "backups/0"), hadTarget: false },
      ]);
      const before = await snapshotDirectory(project);
      await assert.rejects(recoverArtifactTransaction(), {
        message: `Artifact transaction journal operation 0 targets ${join(path)}, which is not a path an artifact transaction writes. ${REMEDY}`,
      });
      assert.deepEqual(await snapshotDirectory(project), before);
      await rm(TRANSACTION_PATH);
    }
    assert.equal(isTransactionTarget("C:\\proj", "C:\\proj\\.agents\\skills\\x.", win32), false);
    assert.equal(isTransactionTarget("C:\\proj", "C:\\proj\\.agents\\skills\\..a", win32), true);
  });
});

// The per-step check also stops part way, with the same remedy, when it cannot check a folder.
test("the rollback stops part way when it cannot check a target's folders", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    await writeFile(join(project, ".agents"), "file\n");
    await assert.rejects(
      rollBackArtifactOperations(project, [
        {
          staged,
          target: join(project, ".agents/skills/a"),
          backup: join(root, "backups/0"),
          hadTarget: false,
        },
      ]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `The artifact transaction rollback stopped before operation 0, because checking the folders above ${join(".agents/skills/a")} for a symbolic link failed with ENOTDIR. It rolled back no operation yet. ${STOPPED_REMEDY}`,
        );
        assert.equal(/** @type {NodeJS.ErrnoException} */ (error.cause).code, "ENOTDIR");
        return true;
      },
    );
  });
});

// #1174: a rollback that would replace or remove a journaled file changed since the stopped
// operation wrote it stops before it changes anything, names each changed file, and gives the
// remedy. The journal comes from a real commit that fails part way, as in the #1092 test above:
// the third operation stages the file the first one moves, so its move fails after the first two
// moved `.gitignore` and the skill folder into place.

/** The remedy that ends each message that refuses to roll back over edited files. */
const EDITED_REMEDY =
  "To keep the edits, move each of these paths out of the project, then run the Calavera command again: the rollback then restores or removes the rest, and you can copy the edits back. To discard the edits, delete each of these paths instead, then run the Calavera command again.";

/**
 * The snapshot of `project` without the `.calavera` folder, where the transaction keeps its
 * journal and staging.
 *
 * @param {string} project
 */
async function projectFiles(project) {
  return Object.fromEntries(
    Object.entries(await snapshotDirectory(project)).filter(
      ([path]) => !path.startsWith(join(project, ".calavera")),
    ),
  );
}

/**
 * Commits `.gitignore` and the skill folder `.agents/skills/a` over earlier versions, through a
 * commit that fails part way, so its journal stays pending.
 *
 * @param {{ project: string, root: string, staged: string }} paths
 */
async function interruptedCommit({ project, root, staged }) {
  await writeFile(join(project, ".gitignore"), "before\n");
  await mkdir(join(project, ".agents/skills/a"), { recursive: true });
  await writeFile(join(project, ".agents/skills/a/SKILL.md"), "# Before\n");
  const before = await projectFiles(project);
  const stagedSkill = join(root, "skill");
  await mkdir(join(stagedSkill, "references"), { recursive: true });
  await writeFile(join(stagedSkill, "SKILL.md"), "# New\n");
  await writeFile(join(stagedSkill, "references/guide.md"), "guide\n");
  await assert.rejects(
    commitArtifactTransaction(root, [
      { staged, target: join(project, ".gitignore") },
      { staged: stagedSkill, target: join(project, ".agents/skills/a") },
      { staged, target: join(project, ".agents/skills/never") },
    ]),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(join(project, ".gitignore"), "utf8"), "staged\n");
  return before;
}

test("a rollback over the files a stopped commit wrote, unchanged, restores the project byte for byte", async () => {
  await inTransactionProject(async (paths) => {
    const before = await interruptedCommit(paths);

    await recoverArtifactTransaction();

    assert.deepEqual(await projectFiles(paths.project), before);
    await assert.rejects(readFile(TRANSACTION_PATH), { code: "ENOENT" });
  });
});

for (const { name, edit, changed } of [
  {
    name: "an edited .gitignore",
    edit: (/** @type {string} */ project) =>
      writeFile(join(project, ".gitignore"), "staged\nmy-secret-line\n"),
    changed: [".gitignore"],
  },
  {
    name: "an edited file in an artifact folder",
    edit: (/** @type {string} */ project) =>
      writeFile(join(project, ".agents/skills/a/references/guide.md"), "my-secret-line\n"),
    changed: [".agents/skills/a"],
  },
  {
    name: "a file added to an artifact folder",
    edit: (/** @type {string} */ project) =>
      writeFile(join(project, ".agents/skills/a/notes.md"), "my-secret-line\n"),
    changed: [".agents/skills/a"],
  },
  {
    name: "an empty folder added to an artifact folder",
    edit: (/** @type {string} */ project) => mkdir(join(project, ".agents/skills/a/empty")),
    changed: [".agents/skills/a"],
  },
  {
    name: "a file in an artifact folder replaced with a symbolic link",
    edit: async (/** @type {string} */ project) => {
      await rm(join(project, ".agents/skills/a/SKILL.md"));
      await symlink("references/guide.md", join(project, ".agents/skills/a/SKILL.md"));
    },
    changed: [".agents/skills/a"],
  },
  {
    name: "an edited .gitignore and an edited artifact folder",
    edit: async (/** @type {string} */ project) => {
      await writeFile(join(project, ".gitignore"), "my-secret-line\n");
      await writeFile(join(project, ".agents/skills/a/SKILL.md"), "my-secret-line\n");
    },
    changed: [".gitignore", ".agents/skills/a"],
  },
]) {
  test(`the rollback stops and changes nothing over ${name}`, async () => {
    await inTransactionProject(async (paths) => {
      await interruptedCommit(paths);
      await edit(paths.project);
      const journal = await readFile(TRANSACTION_PATH, "utf8");
      const edited = await snapshotDirectory(paths.project);

      await assert.rejects(recoverArtifactTransaction(), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `The artifact transaction rollback stopped before changing anything, because it would replace or remove paths that changed after the stopped operation wrote them: ${changed.map((path) => join(path)).join(", ")}. ${EDITED_REMEDY}`,
        );
        assert.doesNotMatch(error.message, /my-secret-line/);
        assert.equal("cause" in error, false);
        return true;
      });

      assert.deepEqual(await snapshotDirectory(paths.project), edited);
      assert.equal(await readFile(TRANSACTION_PATH, "utf8"), journal);
    });
  });
}

// #1174: the remedy works: a person who moves the edited path out of the project and runs the
// command again gets the rollback, and the edits they moved stay byte for byte.
test("after the edited path is moved out of the project, the rollback restores the rest", async () => {
  await inTransactionProject(async (paths) => {
    await interruptedCommit(paths);
    await writeFile(join(paths.project, ".gitignore"), "mine\n");
    await assert.rejects(recoverArtifactTransaction(), /changed after the stopped operation/);

    await rename(join(paths.project, ".gitignore"), join(paths.root, "..", "kept-gitignore"));
    await recoverArtifactTransaction();

    assert.equal(await readFile(join(paths.project, ".gitignore"), "utf8"), "before\n");
    assert.equal(
      await readFile(join(paths.project, ".agents/skills/a/SKILL.md"), "utf8"),
      "# Before\n",
    );
    assert.deepEqual(await readdir(join(paths.project, ".agents/skills/a")), ["SKILL.md"]);
    assert.equal(await readFile(join(paths.root, "..", "kept-gitignore"), "utf8"), "mine\n");
    await assert.rejects(readFile(TRANSACTION_PATH), { code: "ENOENT" });
  });
});

// #1174: a file the person created at a target the stopped operation had not created yet is a
// change too, because the rollback would remove it.
test("the rollback stops over a file created at a target the stopped operation never wrote", async () => {
  await inTransactionProject(async (paths) => {
    await interruptedCommit(paths);
    await writeFile(join(paths.project, ".agents/skills/never"), "mine\n");
    const edited = await snapshotDirectory(paths.project);

    await assert.rejects(recoverArtifactTransaction(), {
      message: `The artifact transaction rollback stopped before changing anything, because it would replace or remove paths that changed after the stopped operation wrote them: ${join(".agents/skills/never")}. ${EDITED_REMEDY}`,
    });
    assert.deepEqual(await snapshotDirectory(paths.project), edited);
  });
});

// #1174: a journal from a Calavera version that did not record what each operation wrote cannot
// show that a path is unchanged, so the rollback stops before it replaces or removes any path that
// exists, and names those paths separately. A target the rollback would not touch, or one that is
// gone, does not stop it.
test("a journal without the recorded fingerprints stops before it replaces or removes an existing path", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    await mkdir(join(project, ".agents/skills"), { recursive: true });
    await writeFile(join(project, ".gitignore"), "written or edited\n");
    await mkdir(join(root, "backups"), { recursive: true });
    await writeFile(join(root, "backups/0"), "before\n");
    await writeFile(join(project, ".agents/skills/kept"), "kept\n");
    await writeFile(join(project, ".agents/skills/created"), "created or edited\n");
    const journal = await writeJournal(root, [
      {
        staged,
        target: join(project, ".gitignore"),
        backup: join(root, "backups/0"),
        hadTarget: true,
      },
      {
        staged,
        target: join(project, ".agents/skills/kept"),
        backup: join(root, "backups/1"),
        hadTarget: true,
      },
      {
        staged,
        target: join(project, ".agents/skills/gone"),
        backup: join(root, "backups/2"),
        hadTarget: false,
      },
      {
        staged,
        target: join(project, ".agents/skills/created"),
        backup: join(root, "backups/3"),
        hadTarget: false,
      },
    ]);
    const before = await snapshotDirectory(project);

    await assert.rejects(recoverArtifactTransaction(), {
      message: `The artifact transaction rollback stopped before changing anything, because the journal does not record what the stopped operation wrote, so Calavera cannot tell whether these paths changed since: .gitignore, ${join(".agents/skills/created")}. ${EDITED_REMEDY}`,
    });
    assert.deepEqual(await snapshotDirectory(project), before);
    assert.equal(await readFile(TRANSACTION_PATH, "utf8"), journal);

    await rm(join(project, ".gitignore"));
    await rm(join(project, ".agents/skills/created"));
    await recoverArtifactTransaction();
    assert.equal(await readFile(join(project, ".gitignore"), "utf8"), "before\n");
    assert.equal(await readFile(join(project, ".agents/skills/kept"), "utf8"), "kept\n");
    await assert.rejects(readFile(TRANSACTION_PATH), { code: "ENOENT" });
  });
});

test("recovery refuses a journal whose recorded fingerprint is not a SHA-256 digest", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    for (const writtenHash of [7, "abc", "A".repeat(64), null, ["a".repeat(64)]]) {
      const journal = `${JSON.stringify({
        schemaVersion: 1,
        transactionRoot: root,
        operations: [
          {
            staged,
            target: join(project, ".gitignore"),
            backup: join(root, "backups/0"),
            hadTarget: false,
            writtenHash,
          },
        ],
      })}\n`;
      await writeFile(TRANSACTION_PATH, journal);
      await assert.rejects(recoverArtifactTransaction(), {
        message: "Invalid artifact transaction journal operation.",
      });
      assert.equal(await readFile(TRANSACTION_PATH, "utf8"), journal);
    }
  });
});

// #1174: a path the check cannot read stops the rollback too, with the error code and the cause.
test(
  "the rollback stops and keeps the cause when it cannot read a path to compare it",
  { skip: process.getuid?.() === 0 },
  async () => {
    await inTransactionProject(async (paths) => {
      await interruptedCommit(paths);
      await chmod(join(paths.project, ".agents/skills/a/references"), 0o000);
      try {
        await assert.rejects(recoverArtifactTransaction(), (error) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            `The artifact transaction rollback stopped before changing anything, because reading ${join(".agents/skills/a")} to compare it with what the stopped operation wrote failed with EACCES. ${EDITED_REMEDY}`,
          );
          assert.equal(/** @type {NodeJS.ErrnoException} */ (error.cause).code, "EACCES");
          return true;
        });
      } finally {
        await chmod(join(paths.project, ".agents/skills/a/references"), 0o755);
      }
      assert.equal(await readFile(join(paths.project, ".gitignore"), "utf8"), "staged\n");
    });
  },
);

// #1174: the fingerprint tells apart each change the rollback must not overwrite, including a
// change only to where a file sits in the folder, or to where a symbolic link points.
test("the written fingerprint changes with each entry's path, kind, bytes, and link target", async () => {
  await inTransactionProject(async ({ root }) => {
    /** @param {Record<string, string | null | { link: string }>} entries */
    const fingerprintOf = async (entries) => {
      const folder = await mkdtemp(join(root, "tree-"));
      for (const [path, value] of Object.entries(entries)) {
        const full = join(folder, path);
        await mkdir(join(full, ".."), { recursive: true });
        if (value === null) await mkdir(full);
        else if (typeof value === "string") await writeFile(full, value);
        else await symlink(value.link, full);
      }
      return writtenFingerprint(folder);
    };
    const digests = [
      await fingerprintOf({ "a/b": "x" }),
      await fingerprintOf({ a: null, b: "x" }),
      await fingerprintOf({ "a/c": "x" }),
      await fingerprintOf({ "a/b": "y" }),
      await fingerprintOf({ "a/b": { link: "one" } }),
      await fingerprintOf({ "a/b": { link: "two" } }),
      await fingerprintOf({ "a/b/c": "x" }),
      await fingerprintOf({ "a/b": null, "a/c": "x" }),
      await fingerprintOf({ d: null, e: "x" }),
      await fingerprintOf({ f: null, e: "x" }),
    ];
    assert.equal(new Set(digests).size, digests.length);
    assert.equal(await fingerprintOf({ "a/b": "x" }), digests[0]);
    for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/);
  });
});

// #1174: an entry that is neither a file, a folder, nor a link, such as a named pipe, is part of the
// fingerprint by its kind only, so the check never reads from it and cannot wait on it.
test(
  "the written fingerprint reads no named pipe",
  { skip: process.platform === "win32" },
  async () => {
    await inTransactionProject(async ({ root }) => {
      const { execFileSync } = await import("node:child_process");
      const folder = join(root, "with-pipe");
      await mkdir(folder);
      execFileSync("mkfifo", [join(folder, "pipe")]);
      const withPipe = await writtenFingerprint(folder);
      await rm(join(folder, "pipe"));
      const without = await writtenFingerprint(folder);
      await writeFile(join(folder, "pipe"), "");
      const withFile = await writtenFingerprint(folder);
      assert.equal(new Set([withPipe, without, withFile]).size, 3);
    });
  },
);

test("recovery refuses a recorded fingerprint with extra text before or after the digest", async () => {
  await inTransactionProject(async ({ project, root, staged }) => {
    for (const writtenHash of [`${"a".repeat(64)}x`, `x${"a".repeat(64)}`]) {
      await writeJournal(root, [
        {
          staged,
          target: join(project, ".gitignore"),
          backup: join(root, "backups/0"),
          hadTarget: false,
          writtenHash,
        },
      ]);
      await assert.rejects(recoverArtifactTransaction(), {
        message: "Invalid artifact transaction journal operation.",
      });
    }
  });
});

// #1174: each reason is named, joined, and every path the check cannot read keeps its error.
test(
  "the rollback names every reason it stops for and keeps each read error",
  { skip: process.getuid?.() === 0 },
  async () => {
    await inTransactionProject(async (paths) => {
      await interruptedCommit(paths);
      await chmod(join(paths.project, ".gitignore"), 0o000);
      await chmod(join(paths.project, ".agents/skills/a/references"), 0o000);
      try {
        await assert.rejects(recoverArtifactTransaction(), (error) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            `The artifact transaction rollback stopped before changing anything, because reading .gitignore to compare it with what the stopped operation wrote failed with EACCES, and reading ${join(".agents/skills/a")} to compare it with what the stopped operation wrote failed with EACCES. ${EDITED_REMEDY}`,
          );
          assert.ok(error.cause instanceof AggregateError);
          assert.deepEqual(
            error.cause.errors.map((/** @type {NodeJS.ErrnoException} */ cause) => cause.code),
            ["EACCES", "EACCES"],
          );
          return true;
        });
      } finally {
        await chmod(join(paths.project, ".gitignore"), 0o644);
        await chmod(join(paths.project, ".agents/skills/a/references"), 0o755);
      }
    });
  },
);

// #1174: a target the check cannot even look up, because its folder cannot be searched, stops the
// rollback with the error code, as a target it cannot read does.
test(
  "the rollback stops when it cannot look up a target in its folder",
  { skip: process.getuid?.() === 0 },
  async () => {
    await inTransactionProject(async (paths) => {
      await interruptedCommit(paths);
      const skills = join(paths.project, ".agents/skills");
      await chmod(skills, 0o000);
      try {
        await assert.rejects(recoverArtifactTransaction(), {
          message: `The artifact transaction rollback stopped before changing anything, because reading ${join(".agents/skills/a")} to compare it with what the stopped operation wrote failed with EACCES, and reading ${join(".agents/skills/never")} to compare it with what the stopped operation wrote failed with EACCES. ${EDITED_REMEDY}`,
        });
      } finally {
        await chmod(skills, 0o755);
      }
      assert.equal(await readFile(join(paths.project, ".gitignore"), "utf8"), "staged\n");
    });
  },
);
