// @ts-check
// Issue #1112, PR 5 of the stack: `eject` writes the `ejected` block at the end of `.gitignore`
// once it has removed everything else, and `apply` removes it (ADR-0017, Amendment 5; ADR-0020,
// Decision 2). The block's contents are fixed text, so an edited block, or a broken marker, stops
// both commands before they write anything, with a remedy that never quotes the person's lines.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listingViolations, namedItems } from "../../../scripts/rehearsal-checks.mjs";
import { ignoreChangeLine } from "../src/apply-summary.js";
import { executeEject, planEject, selectEjectItems } from "../src/eject.js";
import { ejectSummaryLines } from "../src/eject-summary.js";
import { EJECTED_BLOCK, EJECTED_LINE } from "../src/ejected-marker.js";
import { planGitignoreBlocks } from "../src/ignore-lines.js";
import {
  agentBootstrap,
  agentBootstrapTexts,
  doctor,
  ejectProject,
  parseArgs,
} from "../src/index.js";
import { deriveProjectPhase } from "../src/project-phase.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const cliPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));

const START = `# calavera:${EJECTED_BLOCK}:start`;
const END = `# calavera:${EJECTED_BLOCK}:end`;
const BLOCK = `${START}\n${EJECTED_LINE}\n${END}\n`;
const CACHE_BLOCK =
  "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n";
// A line the person adds to the block. No reason may quote it, because a person's file can hold
// anything, a secret included.
const SECRET = "SECRET_TOKEN=do-not-print";
const REMOVE = [{ integration: EJECTED_BLOCK, lines: [EJECTED_LINE] }];

const loadFormatter = async () => ({
  description: "no formatter",
  format: async (/** @type {string} */ _path, /** @type {string} */ text) => text,
});
const guidance = await agentBootstrapTexts(loadFormatter);

/** @param {string} path */
const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** @param {string} path @param {string} text */
async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** @param {(root: string) => Promise<void>} callback */
async function inProject(callback) {
  await using holder = await mkdtempDisposable(join(tmpdir(), "calavera-ejected-block-"));
  const root = await realpath(holder.path);
  const originalDirectory = process.cwd();
  process.chdir(root);
  try {
    await writeFile("package.json", "{}\n");
    await callback(root);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string} cwd @param {string[]} args */
function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.signal, null, `the CLI timed out:\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** @param {string[]} [args] */
const eject = (args = []) => ejectProject(parseArgs(["eject", ...args]), { interactive: false });

/** @param {string[]} args @param {boolean} approve */
async function ejectInteractively(args, approve) {
  /** @type {string[]} */
  const shown = [];
  /** @type {string[]} */
  const asked = [];
  const result = await ejectProject(parseArgs(["eject", ...args]), {
    interactive: true,
    show: (lines) => shown.push(...lines.map(({ text }) => text)),
    confirm: async (message) => {
      asked.push(message);
      return approve;
    },
  });
  return { result, shown: shown.join("\n"), asked };
}

/** @param {import("../src/index.js").EjectResult} result */
const human = (result) =>
  ejectSummaryLines(result)
    .map(({ text }) => text)
    .join("\n");

const phase = async () => (await deriveProjectPhase({ config: "calavera.config.json" })).phase;

// ---------------------------------------------------------------------------------------------
// The .gitignore planner's fixed blocks, which apply removes whatever the records say.
// ---------------------------------------------------------------------------------------------

test("the planner removes a complete fixed block and keeps every other line byte for byte", () => {
  const own = "node_modules/\r\n# mine\r\n";
  const plan = planGitignoreBlocks({
    contents: `${own}${BLOCK.replaceAll("\n", "\r\n")}`,
    declared: [],
    records: [],
    remove: REMOVE,
  });
  assert.equal(plan.contents, own);
  assert.equal(plan.type, "update");
  assert.deepEqual(plan.changes, [
    {
      path: ".gitignore",
      integration: EJECTED_BLOCK,
      type: "update",
      removedLines: [EJECTED_LINE],
    },
  ]);
  assert.deepEqual(plan.records, []);
});

test("the planner removes the fixed block before it appends a declared block", () => {
  const stryker = { integration: "stryker", lines: [".stryker-tmp/"] };
  const plan = planGitignoreBlocks({
    contents: `node_modules/\n${BLOCK}`,
    declared: [stryker],
    records: [],
    remove: REMOVE,
  });
  assert.equal(
    plan.contents,
    "node_modules/\n# calavera:stryker:start\n.stryker-tmp/\n# calavera:stryker:end\n",
  );
  assert.deepEqual(
    plan.changes.map(({ integration }) => integration),
    [EJECTED_BLOCK, "stryker"],
  );
});

test("removing a fixed block that is the whole file leaves an empty .gitignore, which apply keeps", () => {
  // eject creates .gitignore for the block when the project has none. apply keeps the file it
  // empties, as it keeps any file it removes a block from, because no record says who created it.
  const plan = planGitignoreBlocks({ contents: BLOCK, declared: [], records: [], remove: REMOVE });
  assert.equal(plan.contents, "");
  assert.equal(plan.type, "update");
});

test("without a fixed block, or without a .gitignore, the planner changes nothing for it", () => {
  for (const contents of [undefined, "node_modules/\n"]) {
    const plan = planGitignoreBlocks({ contents, declared: [], records: [], remove: REMOVE });
    assert.equal(plan.contents, contents);
    assert.equal(plan.type, undefined);
    assert.deepEqual(plan.changes, []);
  }
});

test("an edited or broken fixed block is a conflict that names it and never quotes the file", () => {
  for (const { contents, problem } of [
    {
      contents: `node_modules/\n${START}\n${EJECTED_LINE}\n${SECRET}\n${END}\n`,
      problem: /holds lines other than/,
    },
    {
      contents: `${START}\n${SECRET}\n`,
      problem: /markers that are unpaired, repeated, out of order, or changed/,
    },
    {
      contents: `  ${START}  ${SECRET}\n${EJECTED_LINE}\n${END}\n`,
      problem: /markers that are unpaired/,
    },
  ]) {
    assert.throws(
      () => planGitignoreBlocks({ contents, declared: [], records: [], remove: REMOVE }),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /Calavera stopped before writing anything/);
        assert.match(error.message, /\.gitignore: the Calavera block for ejected /);
        assert.match(error.message, problem);
        assert.match(error.message, /and run apply again\./);
        assert.equal(error.message.includes(SECRET), false, error.message);
        return true;
      },
    );
  }
});

test("apply's summary says why it removes the ejected block", () => {
  /** @type {import("../src/ignore-lines.js").IgnoreChange} */
  const change = {
    path: ".gitignore",
    integration: EJECTED_BLOCK,
    type: "update",
    removedLines: [EJECTED_LINE],
  };
  assert.equal(
    ignoreChangeLine(change, true),
    `Would remove the ejected block, because apply manages this project again: ${JSON.stringify(EJECTED_LINE)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// The eject planner and the removal.
// ---------------------------------------------------------------------------------------------

/**
 * A recipe, a state, and the cache block, each recorded, and no base skill.
 *
 * @param {{ gitignore?: string | null }} [options] `null` writes no `.gitignore`.
 */
async function writeRecords({ gitignore = `node_modules/\n${CACHE_BLOCK}` } = {}) {
  await write("calavera.config.json", '{ "profile": "minimal" }\n');
  if (gitignore !== null) await write(".gitignore", gitignore);
  await write(
    ".calavera/state.json",
    `${JSON.stringify({
      version: 1,
      integrations: [],
      files: [],
      managedFiles: [],
      aiArtifacts: [],
      aiWiring: [],
      gitignoreBlocks: [{ integration: "artifact-cache", lines: [".calavera/cache/"] }],
    })}\n`,
  );
}

test("a plan that holds Calavera's records adds the block after the file's other changes", async () => {
  await inProject(async () => {
    await writeRecords();
    const plan = await planEject({ guidance, loadFormatter, dryRun: true });
    const { seen: _seen, ...visible } = /** @type {NonNullable<typeof plan.ejectedBlock>} */ (
      plan.ejectedBlock
    );
    // The block goes at the end of the text the artifact-cache block's removal leaves.
    assert.deepEqual(visible, {
      path: ".gitignore",
      type: "update",
      lines: [START, EJECTED_LINE, END],
      contents: `node_modules/\n${BLOCK}`,
      base: "node_modules/\n",
    });
    assert.equal(plan.nothingToDo, false);
  });
});

test("a plan without a .gitignore creates the file with the block alone", async () => {
  await inProject(async () => {
    await write("calavera.config.json", "{}\n");
    const plan = await planEject({ guidance, loadFormatter, dryRun: true });
    assert.equal(plan.ejectedBlock?.type, "write");
    assert.equal(plan.ejectedBlock?.contents, BLOCK);
  });
});

test("each record alone makes eject plan the block, and no record plans none", async () => {
  for (const path of [
    "calavera.config.json",
    ".calavera/state.json",
    ".calavera/artifacts.lock.json",
  ]) {
    await inProject(async () => {
      await write(
        path,
        path.endsWith("lock.json") ? '{ "schemaVersion": 1, "artifacts": [] }\n' : "{}\n",
      );
      const plan = await planEject({ guidance, loadFormatter, dryRun: true });
      assert.ok(plan.ejectedBlock, `${path} makes eject plan the block`);
    });
  }
  await inProject(async () => {
    await write(".calavera/cache/npm/index", "x\n");
    const plan = await planEject({ guidance, loadFormatter, dryRun: true });
    assert.equal(plan.ejectedBlock, undefined);
    assert.deepEqual(plan.reported, []);
    assert.equal(plan.nothingToDo, false);
  });
});

test("a complete block already in .gitignore is kept, and no second one is planned", async () => {
  await inProject(async () => {
    await writeRecords({ gitignore: `node_modules/\n${BLOCK}` });
    const plan = await planEject({ guidance, loadFormatter, dryRun: true });
    assert.equal(plan.ejectedBlock, undefined);
    assert.deepEqual(plan.reported, []);
  });
});

test("an edited block or a broken marker stops eject before it writes anything, with or without records", async () => {
  for (const records of [true, false]) {
    for (const { gitignore, problem } of [
      {
        gitignore: `node_modules/\n${START}\n${SECRET}\n${END}\n`,
        problem: /holds lines other than/,
      },
      { gitignore: `node_modules/\n${END}\n${SECRET}\n`, problem: /markers that are unpaired/ },
    ]) {
      await inProject(async () => {
        if (records) await writeRecords({ gitignore });
        else await write(".gitignore", gitignore);
        const before = await snapshotDirectory();
        for (const dryRun of [true, false]) {
          await assert.rejects(
            planEject({ guidance, loadFormatter, dryRun }),
            (/** @type {Error} */ error) => {
              assert.match(error.message, /^eject stopped before removing anything: /);
              assert.match(error.message, problem);
              assert.match(error.message, /run eject again\.$/);
              assert.equal(error.message.includes(SECRET), false, error.message);
              return true;
            },
          );
        }
        assert.deepEqual(await snapshotDirectory(), before);
      });
    }
  }
});

test("--yes passes the block on only when it leaves nothing, and an approved run always does", async () => {
  await inProject(async () => {
    await writeRecords();
    const plan = await planEject({ guidance, loadFormatter, dryRun: true });
    // The recipe needs an interactive approval, so --yes leaves it and writes no block.
    assert.equal(selectEjectItems(plan, { assumeYes: true }).ejectedBlock, undefined);
    assert.equal(selectEjectItems(plan, { assumeYes: false }).ejectedBlock, plan.ejectedBlock);
    await rm("calavera.config.json");
    const again = await planEject({ guidance, loadFormatter, dryRun: true });
    assert.equal(selectEjectItems(again, { assumeYes: true }).ejectedBlock, again.ejectedBlock);
  });
});

test("the block is written after every other item and before the state is deleted", async () => {
  await inProject(async () => {
    await writeRecords();
    const plan = await planEject({ guidance, loadFormatter, dryRun: false });
    const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
    const outcome = await executeEject(remove, ejectedBlock);
    assert.equal(outcome.ejectedBlock, "written");
    assert.deepEqual(outcome.failed, []);
    assert.equal(await readFile(".gitignore", "utf8"), `node_modules/\n${BLOCK}`);
    assert.equal(await exists(".calavera"), false);
    assert.equal(await phase(), "ejected");

    // A second run has nothing to do and keeps the block.
    const second = await planEject({ guidance, loadFormatter, dryRun: false });
    assert.equal(second.nothingToDo, true);
    assert.equal(second.ejectedBlock, undefined);
  });
});

test("a block that cannot be written keeps the state, and the next run writes it", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores file permissions");
    return;
  }
  await inProject(async () => {
    await writeRecords({ gitignore: "node_modules/\n" });
    await chmod(".gitignore", 0o444);
    try {
      const plan = await planEject({ guidance, loadFormatter, dryRun: false });
      const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
      const outcome = await executeEject(remove, ejectedBlock);
      assert.ok(typeof outcome.ejectedBlock === "object" && "error" in outcome.ejectedBlock);
      assert.match(outcome.ejectedBlock.error.message, /EACCES|EPERM/);
      assert.deepEqual(
        outcome.skipped.map(({ item }) => item.kind),
        ["state"],
      );
      assert.match(outcome.skipped[0]?.reason ?? "", /adding the ejected block failed/);
      assert.equal(await exists(".calavera/state.json"), true);
      assert.equal(await exists("calavera.config.json"), false);
      assert.equal(await phase(), "incomplete");
    } finally {
      await chmod(".gitignore", 0o644);
    }
    const retry = await planEject({ guidance, loadFormatter, dryRun: false });
    const { remove, ejectedBlock } = selectEjectItems(retry, { assumeYes: false });
    assert.equal((await executeEject(remove, ejectedBlock)).ejectedBlock, "written");
    assert.equal(await phase(), "ejected");
  });
});

// Owner decision of 2026-11-26 on #1112: without a state file, the block goes before the last
// remaining record, which is deleted last, so a failed write or a crash always leaves a record
// that makes the next run retry.
for (const { label, write: writeRecord, path } of [
  {
    label: "a recipe",
    write: () => write("calavera.config.json", "{}\n"),
    path: "calavera.config.json",
  },
  {
    label: "a lock",
    write: () =>
      write(".calavera/artifacts.lock.json", '{ "schemaVersion": 1, "artifacts": [] }\n'),
    path: ".calavera/artifacts.lock.json",
  },
]) {
  test(`with only ${label} and no state, a block that cannot be written keeps that record, and the next run writes it`, async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores file permissions");
      return;
    }
    await inProject(async () => {
      await writeRecord();
      await writeFile(".gitignore", "node_modules/\n");
      await chmod(".gitignore", 0o444);
      try {
        const plan = await planEject({ guidance, loadFormatter, dryRun: false });
        const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
        const outcome = await executeEject(remove, ejectedBlock);
        assert.ok(typeof outcome.ejectedBlock === "object" && "error" in outcome.ejectedBlock);
        assert.deepEqual(
          outcome.skipped.map(({ item }) => item.path),
          [path],
        );
        assert.match(outcome.skipped[0]?.reason ?? "", /adding the ejected block failed/);
        assert.equal(await exists(path), true);
      } finally {
        await chmod(".gitignore", 0o644);
      }
      // The record that stayed makes the next run plan the block again. The recipe needs an
      // interactive approval, so the retry is an approved run.
      const { result: retry } = await ejectInteractively([], true);
      assert.equal(retry.status, "ejected");
      assert.equal(retry.ejectedBlock?.outcome, "written");
      assert.equal(await exists(path), false);
      assert.equal(await readFile(".gitignore", "utf8"), `node_modules/\n${BLOCK}`);
      assert.equal(await phase(), "ejected");
    });
  });
}

test("with a recipe and a lock but no state, the lock is the last record, so a failed block write keeps it", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores file permissions");
    return;
  }
  await inProject(async () => {
    // ADR-0017, Amendment 5: the last remaining record is the state, or the lock, or the recipe.
    await write("calavera.config.json", "{}\n");
    await write(".calavera/artifacts.lock.json", '{ "schemaVersion": 1, "artifacts": [] }\n');
    await writeFile(".gitignore", "node_modules/\n");
    await chmod(".gitignore", 0o444);
    try {
      const plan = await planEject({ guidance, loadFormatter, dryRun: false });
      const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
      const outcome = await executeEject(remove, ejectedBlock);
      assert.deepEqual(
        outcome.skipped.map(({ item }) => item.path),
        [".calavera/artifacts.lock.json"],
      );
      assert.equal(await exists("calavera.config.json"), false);
      assert.equal(await exists(".calavera/artifacts.lock.json"), true);
    } finally {
      await chmod(".gitignore", 0o644);
    }
  });
});

test("--yes keeps the cache block while it leaves a state it cannot check", async () => {
  await inProject(async () => {
    // A symbolic link at the state leads to content no record covers, so --yes leaves it, and the
    // block that state records stays with it (owner decision of 2026-11-26 on #1334).
    await writeRecords();
    await write("records/state.json", await readFile(".calavera/state.json", "utf8"));
    await rm(".calavera/state.json");
    const { symlink } = await import("node:fs/promises");
    await symlink("../records/state.json", ".calavera/state.json");
    const plan = await planEject({ guidance, loadFormatter, dryRun: false });
    const { leave } = selectEjectItems(plan, { assumeYes: true });
    assert.deepEqual(leave.map(({ path }) => path).sort(), [
      ".calavera/state.json",
      ".gitignore",
      "calavera.config.json",
    ]);
  });
});

test("without a state, the recipe is deleted after the block, so a stop between them leaves the recipe", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores folder permissions");
    return;
  }
  await inProject(async () => {
    // The recipe sits in a folder eject cannot change, so its deletion fails as a crash would
    // stop the run after the block is written.
    const config = "recipe/calavera.config.json";
    await write(config, "{}\n");
    await write(".agents/calavera/mcp.md", guidance.mcp[0] ?? "");
    await chmod("recipe", 0o555);
    try {
      const plan = await planEject({ guidance, loadFormatter, dryRun: false, config });
      const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
      const outcome = await executeEject(remove, ejectedBlock);
      assert.equal(outcome.ejectedBlock, "written");
      assert.deepEqual(
        outcome.failed.map(({ item }) => item.path),
        [config],
      );
      // Every other item went before the block.
      assert.equal(await exists(".agents/calavera/mcp.md"), false);
      assert.equal(await readFile(".gitignore", "utf8"), BLOCK);
    } finally {
      await chmod("recipe", 0o755);
    }
  });
});

test("after a stop between the block and the last record, the next run keeps the block and deletes the record", async () => {
  await inProject(async () => {
    // What a crash after the block's write leaves: the block and the recipe.
    await write("calavera.config.json", "{}\n");
    await write(".gitignore", BLOCK);
    const result = await eject(["--yes", "--config", "calavera.config.json"]);
    // --yes leaves the recipe for an interactive approval, and an approved run removes it.
    assert.equal(result.ejectedBlock, undefined);
    const { result: approved } = await ejectInteractively([], true);
    assert.equal(approved.status, "ejected");
    assert.equal(approved.ejectedBlock, undefined);
    assert.equal(await exists("calavera.config.json"), false);
    assert.equal(await readFile(".gitignore", "utf8"), BLOCK);
    assert.equal(await phase(), "ejected");
  });
});

test("a removal that fails writes no block and keeps the state", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores folder permissions");
    return;
  }
  await inProject(async () => {
    await writeRecords({ gitignore: "node_modules/\n" });
    await write(".calavera/.staging/leftover/file", "x\n");
    await chmod(".calavera/.staging", 0o555);
    try {
      const plan = await planEject({ guidance, loadFormatter, dryRun: false });
      const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
      const outcome = await executeEject(remove, ejectedBlock);
      assert.deepEqual(
        outcome.failed.map(({ item }) => item.kind),
        ["transient"],
      );
      assert.ok(typeof outcome.ejectedBlock === "object" && "reason" in outcome.ejectedBlock);
      assert.match(outcome.ejectedBlock.reason, /Not added, because an item eject removes first/);
      assert.deepEqual(
        outcome.skipped.map(({ item, reason }) => [item.kind, reason]),
        [
          [
            "state",
            "Kept, because eject did not add the ejected block after a removal failed, and the next run needs this record to add it. Run eject again once that is fixed.",
          ],
        ],
      );
      assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");
      assert.equal(await exists(".calavera/state.json"), true);
    } finally {
      await chmod(".calavera/.staging", 0o755);
    }
  });
});

test("a .gitignore that changed after the plan stops eject before it removes anything", async () => {
  await inProject(async () => {
    await writeRecords({ gitignore: "node_modules/\n" });
    const plan = await planEject({ guidance, loadFormatter, dryRun: false });
    await writeFile(".gitignore", "node_modules/\ndist/\n");
    const before = await snapshotDirectory();
    const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
    await assert.rejects(
      executeEject(remove, ejectedBlock),
      /eject stopped before removing anything, because \.gitignore changed since eject listed/,
    );
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("a .gitignore that leads out of the project gets no block, and eject says so", async () => {
  await inProject(async (root) => {
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-ejected-outside-"));
    const target = join(outside.path, "gitignore");
    await writeFile(target, "node_modules/\n");
    await writeRecords({ gitignore: null });
    const { symlink } = await import("node:fs/promises");
    await symlink(target, join(root, ".gitignore"));
    const plan = await planEject({ guidance, loadFormatter, dryRun: true });
    assert.equal(plan.ejectedBlock, undefined);
    const report = plan.reported.find(({ path }) => path === ".gitignore");
    assert.match(report?.reason ?? "", /does not add the ejected block/);

    // Without Calavera's records there is no block to add, so there is nothing to report either.
    await rm("calavera.config.json");
    await rm(".calavera", { recursive: true });
    const unmanaged = await planEject({ guidance, loadFormatter, dryRun: true });
    assert.deepEqual(unmanaged.reported, []);
  });
});

test("a .gitignore that an earlier step changed gets no block, and the state stays", async () => {
  await inProject(async () => {
    // .gitignore links into the cache, so removing the cache, the first step, changes the file
    // the block would go into.
    await writeRecords({ gitignore: null });
    await write(".calavera/cache/gitignore", "node_modules/\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(".calavera/cache/gitignore", ".gitignore");
    const plan = await planEject({ guidance, loadFormatter, dryRun: false });
    const { remove, ejectedBlock } = selectEjectItems(plan, { assumeYes: false });
    const outcome = await executeEject(remove, ejectedBlock);
    assert.ok(typeof outcome.ejectedBlock === "object" && "error" in outcome.ejectedBlock);
    assert.equal(
      outcome.ejectedBlock.error.message,
      ".gitignore changed since eject listed what it would change, so eject did not add the ejected block. Run eject again to see the new list.",
    );
    assert.equal(await exists(".calavera/state.json"), true);
  });
});

// ---------------------------------------------------------------------------------------------
// The eject command.
// ---------------------------------------------------------------------------------------------

test("the dry run shows the block's lines once, under .gitignore, and --json carries them", async () => {
  await inProject(async () => {
    await writeRecords();
    const before = await snapshotDirectory();
    const result = await eject(["--dry-run"]);
    assert.deepEqual(await snapshotDirectory(), before);
    assert.deepEqual(result.ejectedBlock, {
      path: ".gitignore",
      type: "update",
      lines: [START, EJECTED_LINE, END],
      outcome: "planned",
    });
    assert.match(
      result.message,
      /^Dry run complete\. Nothing was changed\. eject would remove 3 items and then add the block that marks the project as ejected; --yes would leave/,
    );
    const output = human(result);
    assert.match(
      output,
      new RegExp(
        `\\.gitignore \\(unedited\\)\\n(?: {4}.*\\n)* {4}Once everything else is removed, eject adds this block at the end of the file:\\n {6}"# calavera:ejected:start"\\n {6}${JSON.stringify(EJECTED_LINE).replaceAll(".", "\\.")}\\n {6}"# calavera:ejected:end"\\n {4}--yes leaves items for an interactive approval, so it would not add the block\\.`,
      ),
    );
    // The block is printed under the .gitignore item, so it gets no heading of its own.
    assert.doesNotMatch(output, /^Would add:$/m);
    assert.deepEqual(listingViolations(output, namedItems(result)), []);
  });
});

test("under the .gitignore item, the summary says what became of the block", async () => {
  await inProject(async () => {
    // --yes leaves the recipe, so it removes the artifact-cache block and adds no ejected block.
    await writeRecords();
    const yes = await eject(["--yes"]);
    assert.equal(yes.ejectedBlock?.outcome, "left");
    assert.match(
      human(yes),
      /^Removed:\n(?:.*\n)*? {2}\.gitignore \(unedited\)\n(?: {4}.*\n)*? {4}eject adds the block that marks the project as ejected only once everything else is removed, and --yes left items for an interactive approval\.$/m,
    );
  });
  await inProject(async () => {
    await writeRecords();
    const { result } = await ejectInteractively([], true);
    assert.equal(result.ejectedBlock?.outcome, "written");
    const output = human(result);
    assert.match(
      output,
      /^ {2}\.gitignore \(unedited\)\n(?: {4}.*\n)*? {4}eject added the block that marks the project as ejected at the end of the file\.$/m,
    );
    assert.doesNotMatch(output, /^Added:$/m);
    assert.deepEqual(listingViolations(output, namedItems(result)), []);
  });
});

test("a removal that fails before the block is written says so under the block's own entry", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores folder permissions");
    return;
  }
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    await write(".calavera/.staging/leftover/file", "x\n");
    await chmod(".calavera/.staging", 0o555);
    try {
      const result = await eject(["--yes"]);
      assert.equal(result.status, "failed");
      assert.deepEqual(result.ejectedBlock, {
        path: ".gitignore",
        type: "write",
        lines: [START, EJECTED_LINE, END],
        outcome: "skipped",
        error:
          "Not added, because an item eject removes first could not be removed. Run eject again once that is fixed.",
      });
      assert.match(
        result.message,
        /2 items could not be removed, and eject could not add the ejected block; each one says why below\./,
      );
      const output = human(result);
      assert.match(
        output,
        /^Skipped:\n(?:.*\n)*? {2}\.gitignore: Not added, because an item eject removes first could not be removed\./m,
      );
      assert.deepEqual(listingViolations(output, namedItems(result)), []);
      assert.equal(await exists(".gitignore"), false);
    } finally {
      await chmod(".calavera/.staging", 0o755);
    }
  });
});

test("a .gitignore that changed during the run is reported in eject's own words", async () => {
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    await write(".calavera/cache/gitignore", "node_modules/\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(".calavera/cache/gitignore", ".gitignore");
    const { result } = await ejectInteractively([], true);
    assert.equal(result.ejectedBlock?.outcome, "failed");
    assert.equal(
      result.ejectedBlock?.error,
      ".gitignore changed since eject listed what it would change, so eject did not add the ejected block. Run eject again to see the new list.",
    );
  });
});

test("without any other .gitignore change, the dry run lists the block under its own heading", async () => {
  await inProject(async () => {
    await write("calavera.config.json", "{}\n");
    const result = await eject(["--dry-run"]);
    const output = human(result);
    assert.match(
      output,
      /^Would add:\n {2}\.gitignore: eject creates the file with the block that marks the project as ejected, once everything else is removed:\n {6}"# calavera:ejected:start"/m,
    );
    assert.deepEqual(listingViolations(output, namedItems(result)), []);
  });
  await inProject(async () => {
    await write("calavera.config.json", "{}\n");
    await write(".gitignore", "node_modules/\n");
    const output = human(await eject(["--dry-run"]));
    assert.match(
      output,
      /^ {2}\.gitignore: eject adds at the end of the file the block that marks the project as ejected, once everything else is removed:$/m,
    );
  });
});

test("an approved run writes the block, the project reads ejected, and a second run does nothing", async () => {
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    await write("calavera.config.json", '{ "profile": "minimal" }\n');
    const { result, asked } = await ejectInteractively([], true);
    assert.match(asked[0] ?? "", /, and add the block that marks the project as ejected\?$/);
    assert.equal(result.status, "ejected");
    assert.equal(result.ejectedBlock?.outcome, "written");
    assert.match(result.message, /and added the block that marks the project as ejected\.$/);
    assert.equal(await readFile(".gitignore", "utf8"), BLOCK);
    assert.equal(await phase(), "ejected");
    const output = human(result);
    assert.match(output, /^Added:\n {2}\.gitignore: eject created the file with the block/m);
    assert.deepEqual(listingViolations(output, namedItems(result)), []);

    const before = await snapshotDirectory();
    const second = await eject(["--yes"]);
    assert.equal(second.status, "nothing-to-do");
    assert.equal(second.ejectedBlock, undefined);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("--yes that leaves the recipe writes no block, and a second --yes lists exactly what the first left", async () => {
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    await write("calavera.config.json", '{ "profile": "minimal" }\n');
    const first = await eject(["--yes"]);
    assert.equal(first.status, "ejected");
    assert.equal(first.ejectedBlock?.outcome, "left");
    assert.equal(await exists(".gitignore"), false);
    const left = first.items.filter(({ outcome }) => outcome === "left");
    const output = human(first);
    assert.match(
      output,
      /^Left for an interactive run:\n(?:.*\n)*? {2}\.gitignore: eject adds the block that marks the project as ejected only once everything else is removed, and --yes left items for an interactive approval\./m,
    );
    assert.deepEqual(listingViolations(output, namedItems(first)), []);

    const before = await snapshotDirectory();
    const second = await eject(["--yes"]);
    assert.deepEqual(second.items, left);
    assert.equal(second.ejectedBlock?.outcome, "left");
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("--yes writes the block when nothing needs an approval", async () => {
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    const result = await eject(["--yes"]);
    assert.equal(result.status, "ejected");
    assert.equal(result.ejectedBlock?.outcome, "written");
    assert.equal(await readFile(".gitignore", "utf8"), BLOCK);
    assert.equal(await phase(), "ejected");
  });
});

test("a block that cannot be written fails the run, says why, and keeps the state", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores file permissions");
    return;
  }
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    await writeFile(".gitignore", "node_modules/\n");
    await chmod(".gitignore", 0o444);
    try {
      const result = await eject(["--yes"]);
      assert.equal(result.status, "failed");
      assert.equal(result.ejectedBlock?.outcome, "failed");
      assert.match(
        result.ejectedBlock?.error ?? "",
        /^the file system refused it \(open, (?:EACCES|EPERM)\)\.$/,
      );
      const state = result.items.find(({ kind }) => kind === "state");
      assert.equal(state?.outcome, "skipped");
      assert.match(
        result.message,
        /1 item could not be removed, and eject could not add the ejected block; each one says why below\./,
      );
      const output = human(result);
      assert.match(
        output,
        /^Failed:\n {2}\.gitignore: eject could not add the ejected block: the file system refused it \(open, (?:EACCES|EPERM)\)\.\n {4}Fix the cause, then run eject again\.$/m,
      );
      assert.deepEqual(listingViolations(output, namedItems(result)), []);
      assert.equal(await phase(), "incomplete");
    } finally {
      await chmod(".gitignore", 0o644);
    }
  });
});

test("the CLI's human dry run prints the block once and passes the listing check", async () => {
  await inProject(async (root) => {
    await writeRecords();
    const json = runCli(root, ["eject", "--dry-run", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ejectedBlock.seen, undefined, "the check value stays internal");
    assert.equal(parsed.ejectedBlock.contents, undefined, "the file's text stays internal");
    const dryRun = runCli(root, ["eject", "--dry-run"]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.deepEqual(listingViolations(dryRun.stdout, namedItems(parsed)), []);
  });
});

// ---------------------------------------------------------------------------------------------
// apply removes the block; init and --init leave it.
// ---------------------------------------------------------------------------------------------

test("init and --init leave the block, and apply's dry run lists its removal before apply removes it", async () => {
  await inProject(async (root) => {
    await writeFile(".gitignore", `node_modules/\n${BLOCK}`);
    for (const args of [
      ["--init", "--yes", "--mcp-harness", "skip"],
      ["init", "--yes"],
    ]) {
      const run = runCli(root, args);
      assert.equal(run.status, 0, `${args.join(" ")}:\n${run.stdout}\n${run.stderr}`);
      assert.match(await readFile(".gitignore", "utf8"), /# calavera:ejected:start/);
    }
    const before = await readFile(".gitignore", "utf8");
    const dryRun = runCli(root, ["apply", "--dry-run", "--json", "--no-install"]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.ok(
      JSON.parse(dryRun.stdout).ignoreChanges.some(
        (/** @type {{ integration?: string, removedLines?: string[] }} */ change) =>
          change.integration === EJECTED_BLOCK &&
          JSON.stringify(change.removedLines) === JSON.stringify([EJECTED_LINE]),
      ),
    );
    assert.equal(await readFile(".gitignore", "utf8"), before);

    const apply = runCli(root, ["apply", "--yes", "--no-install"]);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
    const after = await readFile(".gitignore", "utf8");
    assert.equal(after.includes("calavera:ejected"), false, after);
    assert.ok(after.startsWith("node_modules/\n"));
  });
});

test("an edited block or a broken marker stops apply before it writes anything", async () => {
  for (const gitignore of [
    `node_modules/\n${START}\n${EJECTED_LINE}\n${SECRET}\n${END}\n`,
    `node_modules/\n${START}\n${SECRET}\n`,
  ]) {
    await inProject(async (root) => {
      const init = runCli(root, ["init", "--yes"]);
      assert.equal(init.status, 0, init.stderr);
      await writeFile(".gitignore", gitignore);
      const before = await snapshotDirectory();
      for (const args of [
        ["apply", "--dry-run", "--no-install"],
        ["apply", "--yes", "--no-install"],
      ]) {
        const run = runCli(root, args);
        const output = `${run.stdout}\n${run.stderr}`;
        assert.equal(run.status, 1, output);
        assert.match(output, /\.gitignore: the Calavera block for ejected /);
        assert.equal(output.includes(SECRET), false, output);
      }
      assert.deepEqual(await snapshotDirectory(), before);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The doctors read the block, and --yes keeps the cache block while it keeps the state.
// ---------------------------------------------------------------------------------------------

test("after eject --yes writes the block, doctor reports the ejected phase", async () => {
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    assert.equal((await eject(["--yes"])).ejectedBlock?.outcome, "written");
    const result = await doctor({ config: "calavera.config.json" });
    assert.equal(result.phase, "ejected");
    assert.equal(result.ok, false);
  });
});
