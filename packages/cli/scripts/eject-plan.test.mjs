// Issue #678, layer 1 of the five-layer stack the owner approved on 2026-11-18: the `eject` planner
// for the items Calavera records itself (ADR-0017). It covers the state, the recipe, the artifact
// lock and package folders, the cache and the transient folders, the base Calavera skill, and the
// `artifact-cache` block in `.gitignore`, with the write order, the recovery of a pending artifact
// transaction, and the records `--yes` keeps. The command is registered in layer 5, so these tests
// call the planner directly.
import assert from "node:assert/strict";
import {
  mkdir,
  lstat,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { hashArtifactPayload } from "@schalkneethling/calavera-artifact-core/registry";

import { hashAiInstall } from "../src/ai/artifacts.js";
import { ejectSteps, executeEject, planEject, selectEjectItems } from "../src/eject.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const SKILL_PATH = ".agents/skills/calavera";
const CACHE_BLOCK =
  "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n";
const PACKAGE_ID = "skill-project-goal";
const PACKAGE_VERSION = "0.1.0";
const PACKAGE_ROOT = `.calavera/packages/${PACKAGE_ID}/${PACKAGE_VERSION}`;

/**
 * Runs `callback` inside a new temporary project.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-eject-"));
  const originalDirectory = process.cwd();
  process.chdir(await realpath(project.path));
  try {
    await writeFile("package.json", "{}\n");
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string} path @param {string} text */
async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/**
 * Writes the footprint a bootstrapped project with one installed artifact package holds, with
 * records that match it.
 *
 * @param {{ skillRecord?: boolean, cacheRecord?: string[] | false, gitignore?: string, packageFolder?: boolean }} [options]
 */
async function writeFootprint({
  skillRecord = true,
  cacheRecord = [".calavera/cache/"],
  gitignore = `node_modules/\n${CACHE_BLOCK}`,
  packageFolder = true,
} = {}) {
  await write(`${SKILL_PATH}/SKILL.md`, "# Calavera\n");
  await write("calavera.config.json", '{ "profile": "minimal" }\n');
  await write(".calavera/cache/npm/index", "cache\n");
  await write(".gitignore", gitignore);
  const lockArtifacts = [];
  if (packageFolder) {
    const payload = /** @type {{ payload: string }} */ (artifactForId(PACKAGE_ID)).payload;
    await write(`${PACKAGE_ROOT}/${payload}/SKILL.md`, "# Project goal\n");
    await write(`${PACKAGE_ROOT}/package.json`, "{}\n");
    lockArtifacts.push({
      id: PACKAGE_ID,
      version: PACKAGE_VERSION,
      payloadHash: await hashArtifactPayload(`${PACKAGE_ROOT}/${payload}`),
    });
  }
  await write(
    ".calavera/artifacts.lock.json",
    `${JSON.stringify({ schemaVersion: 1, artifacts: lockArtifacts }, null, 2)}\n`,
  );
  const state = {
    version: 1,
    integrations: [],
    files: [],
    managedFiles: [],
    aiArtifacts: skillRecord
      ? [
          {
            type: "skill",
            name: "calavera",
            source: "skills/calavera",
            path: SKILL_PATH,
            hash: await hashAiInstall("skill", SKILL_PATH),
          },
        ]
      : [],
    aiWiring: [],
    gitignoreBlocks: cacheRecord ? [{ integration: "artifact-cache", lines: cacheRecord }] : [],
  };
  await write(".calavera/state.json", `${JSON.stringify(state, null, 2)}\n`);
}

/** @param {Awaited<ReturnType<typeof planEject>>} plan @param {string} path */
function item(plan, path) {
  const found = plan.items.find((candidate) => candidate.path === path);
  assert.ok(found, `the plan names ${path}: ${plan.items.map(({ path: p }) => p).join(", ")}`);
  return found;
}

/** @param {{ path: string }[]} items */
const paths = (items) => items.map(({ path }) => path).sort();

test("a dry run lists every recorded footprint item and changes nothing", async () => {
  await inProject(async () => {
    await writeFootprint();
    await write(".calavera/.staging/leftover/file", "x\n");
    await write(".calavera/.transactions/old/file", "x\n");
    const before = await snapshotDirectory();

    const plan = await planEject({ dryRun: true });

    assert.deepEqual(paths(plan.items), [
      ".agents/skills/calavera",
      ".calavera/.staging",
      ".calavera/.transactions",
      ".calavera/artifacts.lock.json",
      ".calavera/cache",
      PACKAGE_ROOT,
      ".calavera/state.json",
      ".gitignore",
      "calavera.config.json",
    ]);
    assert.equal(plan.nothingToDo, false);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("each item says whether it matches Calavera's records, and how its edits were checked", async () => {
  await inProject(async () => {
    await writeFootprint();
    const plan = await planEject({ dryRun: true });

    for (const path of [
      ".calavera/state.json",
      ".calavera/artifacts.lock.json",
      ".calavera/cache",
      SKILL_PATH,
      ".gitignore",
    ]) {
      assert.equal(item(plan, path).matchesRecords, true, path);
    }
    assert.equal(item(plan, SKILL_PATH).edits, "unedited");
    assert.equal(item(plan, ".gitignore").edits, "unedited");
    assert.equal(item(plan, ".gitignore").reason, undefined);
    for (const path of [
      ".calavera/state.json",
      ".calavera/artifacts.lock.json",
      ".calavera/cache",
    ]) {
      assert.equal(item(plan, path).edits, "not-checked", path);
      assert.equal(item(plan, path).reason, undefined, path);
    }

    const recipe = item(plan, "calavera.config.json");
    assert.equal(recipe.edits, "cannot-detect");
    assert.equal(recipe.matchesRecords, false);
    assert.match(recipe.reason ?? "", /the project's recipe; edits cannot be detected/i);
    assert.equal(recipe.action, "delete");
    assert.equal(recipe.kind, "recipe");

    const folder = item(plan, PACKAGE_ROOT);
    assert.equal(folder.action, "delete");
    assert.equal(folder.edits, "cannot-detect");
    assert.equal(folder.matchesRecords, false);
    assert.equal(folder.payload?.edits, "unedited");
    assert.match(folder.reason ?? "", /edits cannot be detected/);
  });
});

test("an edited base skill is listed as edited, and so is one with no record", async () => {
  await inProject(async () => {
    await writeFootprint();
    await writeFile(`${SKILL_PATH}/SKILL.md`, "# Calavera, edited\n");
    const edited = item(await planEject({ dryRun: true }), SKILL_PATH);
    assert.equal(edited.edits, "edited");
    assert.equal(edited.matchesRecords, false);
    assert.match(
      edited.reason ?? "",
      /^The base Calavera skill has local edits \(installed=[0-9a-f]{7}, state=[0-9a-f]{7}\)\.$/,
    );
  });

  await inProject(async () => {
    await writeFootprint({ skillRecord: false });
    // A record of another skill is not the base skill's record.
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    state.aiArtifacts.push({
      type: "skill",
      name: "project-goal",
      source: "skill-project-goal",
      path: ".agents/skills/project-goal",
      hash: await hashAiInstall("skill", SKILL_PATH),
    });
    await writeFile(".calavera/state.json", JSON.stringify(state));
    const unrecorded = item(await planEject({ dryRun: true }), SKILL_PATH);
    assert.equal(unrecorded.edits, "edited");
    assert.equal(unrecorded.matchesRecords, false);
    assert.equal(
      unrecorded.reason,
      ".calavera/state.json holds no record of the base Calavera skill, so eject cannot tell whether you edited it.",
    );
  });
});

test("the base skill is part of the footprint even when the recipe selects skill-calavera", async () => {
  await inProject(async () => {
    await writeFootprint();
    await writeFile("calavera.config.json", '{ "ai": [{ "id": "skill-calavera" }] }\n');
    assert.equal(item(await planEject({ dryRun: true }), SKILL_PATH).action, "delete");
  });
});

test("an item that is already gone is not listed", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await rm(SKILL_PATH, { recursive: true, force: true });
    const plan = await planEject({ dryRun: true });
    assert.equal(
      plan.items.some(({ path }) => path === SKILL_PATH),
      false,
    );
  });
});

test("the artifact-cache block edit removes only Calavera's lines", async () => {
  await inProject(async () => {
    await writeFootprint({ gitignore: `node_modules/\n${CACHE_BLOCK}dist/\n` });
    const block = item(await planEject({ dryRun: true }), ".gitignore");
    assert.equal(block.action, "edit");
    assert.deepEqual(block.removedLines, [".calavera/cache/"]);
    assert.equal(block.contents, "node_modules/\ndist/\n");
  });
});

test("an edited artifact-cache block, or one with no record, is listed as edited", async () => {
  await inProject(async () => {
    await writeFootprint({
      gitignore:
        "# calavera:artifact-cache:start\n.calavera/cache/\n*.log\n# calavera:artifact-cache:end\n",
    });
    const block = item(await planEject({ dryRun: true }), ".gitignore");
    assert.equal(block.edits, "edited");
    assert.equal(block.matchesRecords, false);
    assert.equal(block.contents, "");
    assert.equal(block.reason, "The artifact-cache block was edited since Calavera wrote it.");
  });

  await inProject(async () => {
    await writeFootprint({ cacheRecord: false });
    const block = item(await planEject({ dryRun: true }), ".gitignore");
    assert.equal(block.edits, "edited");
    assert.equal(block.matchesRecords, false);
    assert.equal(
      block.reason,
      ".calavera/state.json holds no record of the artifact-cache block, so eject cannot tell whether you edited it.",
    );
  });
});

test("a broken artifact-cache marker stops eject before it writes anything", async () => {
  await inProject(async () => {
    await writeFootprint({
      gitignore: "# calavera:artifact-cache:start\n.calavera/cache/\n",
    });
    const before = await snapshotDirectory();
    await assert.rejects(
      planEject({ dryRun: false }),
      /eject stopped before removing anything: \.gitignore: the Calavera block for artifact-cache has a start marker without an end marker.*run eject again\.$/s,
    );
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("a cache with no block, and a block with no cache, are each handled alone", async () => {
  await inProject(async () => {
    await writeFootprint({ gitignore: "node_modules/\n" });
    const plan = await planEject({ dryRun: true });
    assert.equal(
      plan.items.some(({ path }) => path === ".gitignore"),
      false,
    );
    assert.equal(item(plan, ".calavera/cache").action, "delete");
  });

  await inProject(async () => {
    await writeFootprint();
    await rm(".calavera/cache", { recursive: true, force: true });
    const plan = await planEject({ dryRun: true });
    assert.equal(item(plan, ".gitignore").action, "edit");
  });
});

test("a package folder whose payload was edited lists the payload as edited", async () => {
  await inProject(async () => {
    await writeFootprint();
    const payload = /** @type {{ payload: string }} */ (artifactForId(PACKAGE_ID)).payload;
    await writeFile(`${PACKAGE_ROOT}/${payload}/SKILL.md`, "# Edited\n");
    const folder = item(await planEject({ dryRun: true }), PACKAGE_ROOT);
    assert.equal(folder.payload?.edits, "edited");
    assert.equal(folder.matchesRecords, false);
  });
});

test("a package folder no lock entry names, or for an artifact the catalog lacks, cannot be checked", async () => {
  await inProject(async () => {
    // The lock names skill-project-goal 0.1.0 only, so neither another version of it nor another
    // artifact at that version matches the entry.
    await writeFootprint();
    await write(".calavera/packages/skill-project-goal/9.9.9/package.json", "{}\n");
    await write(".calavera/packages/skill-code-review/0.1.0/package.json", "{}\n");
    await write(".calavera/packages/skill-retired/1.0.0/package.json", "{}\n");
    const lock = JSON.parse(await readFile(".calavera/artifacts.lock.json", "utf8"));
    lock.artifacts.push({ id: "skill-retired", version: "1.0.0", payloadHash: "x" });
    await writeFile(".calavera/artifacts.lock.json", JSON.stringify(lock));
    const plan = await planEject({ dryRun: true });
    for (const path of [
      ".calavera/packages/skill-project-goal/9.9.9",
      ".calavera/packages/skill-code-review/0.1.0",
    ]) {
      const folder = item(plan, path);
      assert.equal(folder.edits, "cannot-detect", path);
      assert.equal(folder.payload, undefined, path);
      assert.equal(folder.matchesRecords, false, path);
      assert.equal(
        folder.reason,
        "No entry in .calavera/artifacts.lock.json names this package folder; edits cannot be detected.",
      );
    }
    const retired = item(plan, ".calavera/packages/skill-retired/1.0.0");
    assert.equal(retired.payload, undefined);
    assert.equal(
      retired.reason,
      "The catalog no longer has skill-retired, so there is no payload path to check; edits cannot be detected.",
    );
    assert.equal(item(plan, PACKAGE_ROOT).payload?.edits, "unedited");
  });

  await inProject(async () => {
    await writeFootprint();
    await rm(".calavera/artifacts.lock.json");
    const folder = item(await planEject({ dryRun: true }), PACKAGE_ROOT);
    assert.equal(folder.payload, undefined);
    assert.equal(folder.edits, "cannot-detect");
  });
});

test("--yes removes only items that match Calavera's records, and keeps the records a left item needs", async () => {
  await inProject(async () => {
    await writeFootprint();
    const { remove, leave } = selectEjectItems(await planEject({ dryRun: false }), {
      assumeYes: true,
    });
    // The package folder stays, so the lock that checks it stays too.
    assert.deepEqual(paths(leave), [
      ".calavera/artifacts.lock.json",
      PACKAGE_ROOT,
      "calavera.config.json",
    ]);
    assert.deepEqual(paths(remove), [
      ".agents/skills/calavera",
      ".calavera/cache",
      ".calavera/state.json",
      ".gitignore",
    ]);
  });

  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await writeFile(`${SKILL_PATH}/SKILL.md`, "# Edited\n");
    const { remove, leave } = selectEjectItems(await planEject({ dryRun: false }), {
      assumeYes: true,
    });
    // The edited skill stays, so the state that records its hash stays too; the lock checks no
    // package folder, so it goes.
    assert.deepEqual(
      paths(leave),
      [SKILL_PATH, ".calavera/state.json", "calavera.config.json"].sort(),
    );
    assert.ok(paths(remove).includes(".calavera/artifacts.lock.json"));
  });

  await inProject(async () => {
    await writeFootprint({
      packageFolder: false,
      gitignore: "# calavera:artifact-cache:start\nedited/\n# calavera:artifact-cache:end\n",
    });
    const { leave } = selectEjectItems(await planEject({ dryRun: false }), { assumeYes: true });
    assert.deepEqual(paths(leave), [".calavera/state.json", ".gitignore", "calavera.config.json"]);
  });
});

test("an approved run removes every item", async () => {
  await inProject(async () => {
    await writeFootprint();
    const plan = await planEject({ dryRun: false });
    const { remove, leave } = selectEjectItems(plan, { assumeYes: false });
    assert.deepEqual(leave, []);
    assert.deepEqual(paths(remove), paths(plan.items));
  });
});

test("the steps run in the order ADR-0017 Decision 7 sets", async () => {
  await inProject(async () => {
    await writeFootprint();
    await write(".calavera/.transactions/old/file", "x\n");
    const plan = await planEject({ dryRun: false });
    const order = ejectSteps(selectEjectItems(plan, { assumeYes: false }).remove).map(
      ({ path }) => path,
    );
    const at = (/** @type {string} */ path) => order.indexOf(path);
    assert.ok(at(".calavera/cache") < at(".gitignore"), "the cache goes before its block");
    assert.ok(at(PACKAGE_ROOT) < at(".calavera/artifacts.lock.json"), "folders before the lock");
    assert.equal(order.at(-1), ".calavera/state.json", "the state goes last");
    assert.ok(at(SKILL_PATH) < at(".calavera/state.json"));
    assert.ok(at(".gitignore") < at("calavera.config.json"), "the block before the other files");
    assert.ok(at(".gitignore") < at(SKILL_PATH));
    assert.ok(at(".calavera/.transactions") < at(PACKAGE_ROOT));
  });
});

test("an approved run removes the footprint, keeps everything else, and a second plan has nothing to do", async () => {
  await inProject(async () => {
    await writeFootprint({ gitignore: `node_modules/\n${CACHE_BLOCK}` });
    await write(".agents/skills/project-goal/SKILL.md", "# Kept\n");
    const plan = await planEject({ dryRun: false });
    await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);

    const after = await snapshotDirectory();
    assert.deepEqual(Object.keys(after).sort(), [
      ".agents/",
      ".agents/skills/",
      ".agents/skills/project-goal/",
      ".agents/skills/project-goal/SKILL.md",
      ".gitignore",
      "package.json",
    ]);
    assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");

    const again = await planEject({ dryRun: true });
    assert.equal(again.nothingToDo, true);
    assert.deepEqual(again.items, []);
  });
});

test("a --yes run leaves what needs approval, and the next approved run finishes", async () => {
  await inProject(async () => {
    await writeFootprint();
    await executeEject(
      selectEjectItems(await planEject({ dryRun: false }), { assumeYes: true }).remove,
    );
    const second = await planEject({ dryRun: true });
    assert.deepEqual(paths(second.items), [
      ".calavera/artifacts.lock.json",
      PACKAGE_ROOT,
      "calavera.config.json",
    ]);
    // The payload is still checked against the lock that --yes kept.
    assert.equal(item(second, PACKAGE_ROOT).payload?.edits, "unedited");

    await executeEject(selectEjectItems(second, { assumeYes: false }).remove);
    // The folders that held the base skill stay, as ADR-0017 leaves every folder it empties other
    // than .calavera/ and .agents/calavera/.
    assert.deepEqual(Object.keys(await snapshotDirectory()).sort(), [
      ".agents/",
      ".agents/skills/",
      ".gitignore",
      "package.json",
    ]);
  });
});

test("a file in .calavera that eject does not name is kept and listed, with its folders", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await write(".calavera/zz-notes.md", "mine\n");
    await write(".calavera/packages/README.md", "mine\n");
    const plan = await planEject({ dryRun: false });
    assert.deepEqual(plan.kept, [".calavera/packages/README.md", ".calavera/zz-notes.md"]);

    await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
    const after = Object.keys(await snapshotDirectory()).sort();
    assert.ok(after.includes(".calavera/zz-notes.md"));
    assert.ok(after.includes(".calavera/packages/README.md"));
    assert.equal(after.includes(".calavera/state.json"), false);
  });
});

test("a symbolic link where a package folder would be is kept, not followed", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    await write(join(outside.path, "package.json"), "{}\n");
    const link = ".calavera/packages/skill-project-goal/0.1.0";
    await mkdir(dirname(link), { recursive: true });
    await symlink(outside.path, link);
    const plan = await planEject({ dryRun: false });
    assert.deepEqual(plan.kept, [link]);
    await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
    assert.equal(await readFile(join(outside.path, "package.json"), "utf8"), "{}\n");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  });
});

test("a pending artifact transaction stops a dry run, and a real run recovers it first", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    const transactionRoot = join(process.cwd(), ".calavera/.transactions/pending");
    await write(join(transactionRoot, "staged/SKILL.md"), "# New\n");
    await write(
      ".calavera/artifact-transaction.json",
      `${JSON.stringify({
        schemaVersion: 1,
        transactionRoot,
        operations: [
          {
            staged: join(transactionRoot, "staged"),
            target: join(process.cwd(), ".agents/skills/new"),
            backup: join(transactionRoot, "backups/0"),
            hadTarget: false,
          },
        ],
      })}\n`,
    );
    const before = await snapshotDirectory();
    await assert.rejects(
      planEject({ dryRun: true }),
      /pending artifact transaction.*eject without --dry-run/s,
    );
    assert.deepEqual(await snapshotDirectory(), before);

    await planEject({ dryRun: false });
    const after = Object.keys(await snapshotDirectory());
    // The rollback ran: the journal is gone, and the install it described was undone.
    assert.equal(after.includes(".calavera/artifact-transaction.json"), false);
    assert.equal(after.includes(".agents/skills/new/"), false);
  });
});

test("a project with no footprint has nothing to do", async () => {
  await inProject(async () => {
    const plan = await planEject({ dryRun: true });
    assert.equal(plan.nothingToDo, true);
    assert.deepEqual(plan.items, []);
    assert.deepEqual(plan.kept, []);
  });
});

test("a multi-line block that matches its record is unedited, and an empty block removes no lines", async () => {
  await inProject(async () => {
    await writeFootprint({
      cacheRecord: [".calavera/cache/", ".calavera/tmp/"],
      gitignore:
        "# calavera:artifact-cache:start\n.calavera/cache/\n.calavera/tmp/\n# calavera:artifact-cache:end\n",
    });
    const block = item(await planEject({ dryRun: true }), ".gitignore");
    assert.equal(block.edits, "unedited");
    assert.deepEqual(block.removedLines, [".calavera/cache/", ".calavera/tmp/"]);
  });

  await inProject(async () => {
    await writeFootprint({
      gitignore: "a\n# calavera:artifact-cache:start\n# calavera:artifact-cache:end\n",
    });
    const block = item(await planEject({ dryRun: true }), ".gitignore");
    assert.deepEqual(block.removedLines, []);
    assert.equal(block.contents, "a\n");
  });
});

test("the transient folders are listed as Calavera's own", async () => {
  await inProject(async () => {
    await write(".calavera/.staging/leftover/file", "x\n");
    const staging = item(await planEject({ dryRun: true }), ".calavera/.staging");
    assert.equal(staging.kind, "transient");
    assert.equal(staging.matchesRecords, true);
  });
});

test("a record that cannot be read is treated as missing, and the plan says why", async () => {
  await inProject(async () => {
    await writeFootprint();
    await writeFile(".calavera/state.json", "{ not json");
    await writeFile(".calavera/artifacts.lock.json", "{ not json");
    const plan = await planEject({ dryRun: true });
    const stateReason = item(plan, ".calavera/state.json").reason ?? "";
    assert.match(
      stateReason,
      /^Calavera could not read \.calavera\/state\.json \(.+\), so the items/,
    );
    assert.equal(item(plan, SKILL_PATH).edits, "edited");
    assert.equal(item(plan, SKILL_PATH).reason, stateReason);
    assert.equal(item(plan, ".gitignore").edits, "edited");
    assert.equal(item(plan, ".gitignore").reason, stateReason);
    const lockReason = item(plan, ".calavera/artifacts.lock.json").reason ?? "";
    assert.match(lockReason, /^Calavera could not read \.calavera\/artifacts\.lock\.json/);
    assert.equal(item(plan, PACKAGE_ROOT).reason, `${lockReason}; edits cannot be detected.`);
  });
});

test("a failed recovery stops eject, names the journal, and keeps the cause", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await write(".calavera/artifact-transaction.json", '{ "schemaVersion": 2 }\n');
    const error = await planEject({ dryRun: false }).then(
      () => assert.fail("eject recovered an invalid journal"),
      (/** @type {Error} */ caught) => caught,
    );
    assert.match(
      error.message,
      /^eject stopped before removing anything, because recovering the pending artifact transaction in \.calavera\/artifact-transaction\.json failed: Invalid artifact transaction journal\./,
    );
    assert.equal(
      /** @type {Error} */ (error.cause).message,
      "Invalid artifact transaction journal.",
    );
  });
});

test("a footprint path that leads out of the project stops the plan", async () => {
  await inProject(async () => {
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    await write(join(outside.path, "skills/calavera/SKILL.md"), "# Not the project's\n");
    await symlink(outside.path, ".agents");
    await assert.rejects(planEject({ dryRun: true }), /Eject path must stay inside/);
  });
});

const isRoot = process.getuid?.() === 0;

test(
  "a path eject cannot inspect stops the plan instead of counting as gone",
  { skip: isRoot },
  async () => {
    await inProject(async () => {
      await writeFootprint({ packageFolder: false });
      const { chmod } = await import("node:fs/promises");
      await chmod(".agents/skills", 0o000);
      try {
        await assert.rejects(planEject({ dryRun: true }), { code: "EACCES" });
      } finally {
        await chmod(".agents/skills", 0o755);
      }
    });
  },
);

test(
  "a package folder whose delete stops part way is moved out whole first",
  { skip: isRoot },
  async () => {
    await inProject(async () => {
      await writeFootprint();
      // A folder without write permission keeps its files, so the delete stops part way.
      await write(`${PACKAGE_ROOT}/locked/file`, "x\n");
      const { chmod, readdir } = await import("node:fs/promises");
      await chmod(`${PACKAGE_ROOT}/locked`, 0o555);
      const plan = await planEject({ dryRun: false });
      const folder = item(plan, PACKAGE_ROOT);
      try {
        const outcome = await executeEject([folder, item(plan, ".calavera/artifacts.lock.json")]);
        assert.deepEqual(
          outcome.failed.map(({ item: failed }) => failed.path),
          [PACKAGE_ROOT],
        );
        // The lock still checks the folder's payload, so it stays.
        assert.deepEqual(
          outcome.skipped.map(({ item: skipped }) => skipped.path),
          [".calavera/artifacts.lock.json"],
        );
        assert.equal(outcome.failed[0]?.error.code ?? "", "EACCES");
        // The package folder is no longer in .calavera/packages/, half removed, but whole in
        // .calavera/.staging/, which the next run removes.
        assert.deepEqual(await readdir(".calavera/packages/skill-project-goal"), []);
        const [holder] = await readdir(".calavera/.staging");
        assert.ok(holder?.startsWith("eject-"));
        assert.equal(
          await readFile(`.calavera/.staging/${holder}/package/locked/file`, "utf8"),
          "x\n",
        );
      } finally {
        const [holder] = await readdir(".calavera/.staging");
        await chmod(`.calavera/.staging/${holder}/package/locked`, 0o755);
      }
      const next = await planEject({ dryRun: false });
      assert.equal(item(next, ".calavera/.staging").kind, "transient");
    });
  },
);

test("another block's record is not the artifact-cache block's record", async () => {
  await inProject(async () => {
    await writeFootprint({ cacheRecord: false });
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    state.gitignoreBlocks.push({ integration: "varlock", lines: [".calavera/cache/"] });
    await writeFile(".calavera/state.json", JSON.stringify(state));
    assert.equal(item(await planEject({ dryRun: true }), ".gitignore").edits, "edited");
  });
});

test("a base skill or payload that cannot be hashed is listed as edited", async () => {
  await inProject(async () => {
    await writeFootprint();
    await rm(SKILL_PATH, { recursive: true });
    await writeFile(SKILL_PATH, "not a folder\n");
    const payload = /** @type {{ payload: string }} */ (artifactForId(PACKAGE_ID)).payload;
    await rm(`${PACKAGE_ROOT}/${payload}`, { recursive: true });
    const plan = await planEject({ dryRun: true });
    assert.match(item(plan, SKILL_PATH).reason ?? "", /installed=unreadable: /);
    assert.equal(item(plan, PACKAGE_ROOT).payload?.edits, "edited");
  });
});

test("a run with nothing to remove leaves an empty .calavera folder, and one without packages works", async () => {
  await inProject(async () => {
    await mkdir(".calavera");
    await executeEject([]);
    assert.deepEqual(Object.keys(await snapshotDirectory()).sort(), [".calavera/", "package.json"]);
  });

  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await executeEject(
      selectEjectItems(await planEject({ dryRun: false }), { assumeYes: false }).remove,
    );
    assert.equal(
      Object.keys(await snapshotDirectory()).some((path) => path.startsWith(".calavera")),
      false,
    );
  });
});

test("eject removes nothing when an item changed after the plan was made", async () => {
  await inProject(async () => {
    await writeFootprint({ gitignore: `a\n${CACHE_BLOCK}` });
    const plan = await planEject({ dryRun: false });
    // The person adds a line, and edits the skill, while the approval prompt waits.
    await writeFile(".gitignore", `a\nnew-line\n${CACHE_BLOCK}`);
    await writeFile(`${SKILL_PATH}/SKILL.md`, "# Edited after the plan\n");
    const before = await snapshotDirectory();
    await assert.rejects(
      executeEject(selectEjectItems(plan, { assumeYes: false }).remove),
      /eject stopped before removing anything, because \.agents\/skills\/calavera, \.gitignore changed since eject listed/,
    );
    assert.deepEqual(await snapshotDirectory(), before);
  });

  await inProject(async () => {
    await writeFootprint();
    const plan = await planEject({ dryRun: false });
    await writeFile(`${SKILL_PATH}/SKILL.md`, "# Edited after the plan\n");
    await assert.rejects(
      executeEject(selectEjectItems(plan, { assumeYes: false }).remove),
      /\.agents\/skills\/calavera changed since/,
    );
  });

  await inProject(async () => {
    await writeFootprint();
    const plan = await planEject({ dryRun: false });
    const payload = /** @type {{ payload: string }} */ (artifactForId(PACKAGE_ID)).payload;
    await writeFile(`${PACKAGE_ROOT}/${payload}/SKILL.md`, "# Edited after the plan\n");
    await assert.rejects(
      executeEject(selectEjectItems(plan, { assumeYes: false }).remove),
      /skill-project-goal\/0\.1\.0 changed since/,
    );
  });
});

test("a lock entry without a payload hash never makes a missing payload unedited", async () => {
  await inProject(async () => {
    await writeFootprint();
    const payload = /** @type {{ payload: string }} */ (artifactForId(PACKAGE_ID)).payload;
    await rm(`${PACKAGE_ROOT}/${payload}`, { recursive: true });
    await writeFile(
      ".calavera/artifacts.lock.json",
      JSON.stringify({
        schemaVersion: 1,
        artifacts: [{ id: PACKAGE_ID, version: PACKAGE_VERSION }],
      }),
    );
    assert.equal(item(await planEject({ dryRun: true }), PACKAGE_ROOT).payload?.edits, "edited");
  });
});

test("a lock with a malformed entry is treated as unreadable, and the plan names it", async () => {
  await inProject(async () => {
    await writeFootprint();
    await writeFile(".calavera/artifacts.lock.json", '{ "schemaVersion": 1, "artifacts": [null] }');
    const plan = await planEject({ dryRun: true });
    assert.equal(
      item(plan, ".calavera/artifacts.lock.json").reason,
      "Calavera could not read .calavera/artifacts.lock.json (artifact entry 0 does not name a string id and version), so the items it checks are listed as edited or as unknown.",
    );
    assert.equal(item(plan, PACKAGE_ROOT).payload, undefined);
  });
});

test("a packages entry that is not a folder, and an empty package ID folder, are kept and listed", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    await symlink(outside.path, ".calavera/packages");
    const plan = await planEject({ dryRun: false });
    assert.deepEqual(plan.kept, [".calavera/packages"]);
    await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
    assert.equal((await lstat(".calavera/packages")).isSymbolicLink(), true);
  });

  await inProject(async () => {
    await writeFootprint();
    await mkdir(".calavera/packages/skill-empty");
    const plan = await planEject({ dryRun: false });
    assert.deepEqual(plan.kept, [".calavera/packages/skill-empty"]);
    await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
    // The folder it emptied goes; the one it did not name stays, and keeps .calavera/ with it.
    assert.deepEqual(
      Object.keys(await snapshotDirectory()).filter((path) => path.startsWith(".calavera")),
      [".calavera/", ".calavera/packages/", ".calavera/packages/skill-empty/"],
    );
  });
});

test("a recipe path that names package.json is refused", async () => {
  await inProject(async () => {
    await writeFootprint();
    await assert.rejects(
      planEject({ dryRun: true, config: "package.json" }),
      /recipe path package\.json names a package\.json, which eject never changes/,
    );
    await assert.rejects(
      planEject({ dryRun: true, config: "nested/package.json" }),
      /names a package\.json/,
    );
  });
});

test(
  "a failed removal does not stop the others, and the items that depend on it stay",
  { skip: isRoot },
  async () => {
    await inProject(async () => {
      await writeFootprint({ packageFolder: false });
      // A cache folder whose files cannot be deleted.
      const { chmod } = await import("node:fs/promises");
      await chmod(".calavera/cache/npm", 0o555);
      try {
        const outcome = await executeEject(
          selectEjectItems(await planEject({ dryRun: false }), { assumeYes: false }).remove,
        );
        assert.deepEqual(paths(outcome.failed.map(({ item: failed }) => failed)), [
          ".calavera/cache",
        ]);
        // The block that hides the cache stays, and so does the state that records the block.
        assert.deepEqual(paths(outcome.skipped.map(({ item: skipped }) => skipped)), [
          ".calavera/state.json",
          ".gitignore",
        ]);
        assert.match(
          outcome.skipped[0]?.reason ?? "",
          /removing the (cache|artifact-cache-block) item it depends on failed/,
        );
        // Independent items were removed.
        assert.deepEqual(paths(outcome.removed), [
          ".agents/skills/calavera",
          ".calavera/artifacts.lock.json",
          "calavera.config.json",
        ]);
        assert.equal(await readFile(".gitignore", "utf8"), `node_modules/\n${CACHE_BLOCK}`);
      } finally {
        await chmod(".calavera/cache/npm", 0o755);
      }
    });
  },
);

test(
  "the state stays while the base skill it checks could not be removed",
  { skip: isRoot },
  async () => {
    await inProject(async () => {
      await writeFootprint({ packageFolder: false, gitignore: "node_modules/\n" });
      const { chmod } = await import("node:fs/promises");
      await chmod(SKILL_PATH, 0o555);
      try {
        const outcome = await executeEject(
          selectEjectItems(await planEject({ dryRun: false }), { assumeYes: false }).remove,
        );
        assert.deepEqual(paths(outcome.failed.map(({ item: failed }) => failed)), [SKILL_PATH]);
        assert.deepEqual(paths(outcome.skipped.map(({ item: skipped }) => skipped)), [
          ".calavera/state.json",
        ]);
      } finally {
        await chmod(SKILL_PATH, 0o755);
      }
    });
  },
);

for (const [label, entry] of [
  ["a string", "skill-project-goal"],
  ["an entry without an id", { version: PACKAGE_VERSION }],
  ["an entry without a version", { id: PACKAGE_ID }],
]) {
  test(`a lock entry that is ${label} makes the lock unreadable`, async () => {
    await inProject(async () => {
      await writeFootprint();
      await writeFile(
        ".calavera/artifacts.lock.json",
        JSON.stringify({ schemaVersion: 1, artifacts: [entry] }),
      );
      assert.match(
        item(await planEject({ dryRun: true }), ".calavera/artifacts.lock.json").reason ?? "",
        /artifact entry 0 does not name a string id and version/,
      );
    });
  });
}

// ADR-0017 Amendment 1 (owner decision of 2026-11-18 on #678): `hashAiInstall` skips symbolic
// links and empty folders, so a base skill that holds either has content no record covers, and
// `--yes` leaves it for an interactive approval.
for (const [label, addUncovered, entry] of [
  [
    "a symbolic link",
    async () => symlink("SKILL.md", `${SKILL_PATH}/notes-link`),
    `${SKILL_PATH}/notes-link`,
  ],
  ["an empty folder", async () => mkdir(`${SKILL_PATH}/drafts`), `${SKILL_PATH}/drafts`],
  [
    "a symbolic link inside a folder",
    async () => {
      await write(`${SKILL_PATH}/references/guide.md`, "# Guide\n");
      await symlink("guide.md", `${SKILL_PATH}/references/link`);
    },
    `${SKILL_PATH}/references/link`,
  ],
  [
    "a folder that holds only an empty folder",
    async () => mkdir(`${SKILL_PATH}/outer/inner`, { recursive: true }),
    `${SKILL_PATH}/outer/inner`,
  ],
  [
    "a symbolic link to a folder, which it does not follow",
    async () => {
      await write(".agents/elsewhere/empty-inside/.keep", "");
      await rm(".agents/elsewhere/empty-inside/.keep");
      await symlink("../../elsewhere", `${SKILL_PATH}/linked`);
    },
    `${SKILL_PATH}/linked`,
  ],
  [
    "an empty folder inside a folder",
    async () => {
      await write(`${SKILL_PATH}/references/guide.md`, "# Guide\n");
      await mkdir(`${SKILL_PATH}/references/empty`);
    },
    `${SKILL_PATH}/references/empty`,
  ],
]) {
  test(`a base skill that holds ${label} needs an interactive approval`, async () => {
    await inProject(async () => {
      await writeFootprint({ packageFolder: false });
      await addUncovered();
      // The record is taken after the change, so the hash still matches: only the uncovered
      // entry tells this skill apart from an unedited one.
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      state.aiArtifacts[0].hash = await hashAiInstall("skill", SKILL_PATH);
      await writeFile(".calavera/state.json", JSON.stringify(state));

      const plan = await planEject({ dryRun: false });
      const skill = item(plan, SKILL_PATH);
      assert.equal(skill.edits, "cannot-detect");
      assert.equal(skill.matchesRecords, false);
      assert.equal(
        skill.reason,
        `The base Calavera skill matches its record, but the record's hash does not cover symbolic links or empty folders, so edits cannot be detected for: ${entry}.`,
      );
      const { remove, leave } = selectEjectItems(plan, { assumeYes: true });
      assert.deepEqual(
        paths(leave),
        [SKILL_PATH, ".calavera/state.json", "calavera.config.json"].sort(),
      );
      assert.equal(paths(remove).includes(SKILL_PATH), false);
    });
  });
}

test("an edited base skill names the entries its hash does not cover too", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await writeFile(`${SKILL_PATH}/SKILL.md`, "# Edited\n");
    await mkdir(`${SKILL_PATH}/drafts`);
    const skill = item(await planEject({ dryRun: true }), SKILL_PATH);
    assert.equal(skill.edits, "edited");
    assert.match(
      skill.reason ?? "",
      /^The base Calavera skill has local edits \(installed=.+\)\. The record's hash does not cover symbolic links or empty folders, so edits cannot be detected for: \.agents\/skills\/calavera\/drafts\.$/,
    );
  });
});

test("a base skill that is itself a symbolic link needs an interactive approval", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await write(".agents/skills/real-calavera/SKILL.md", "# Calavera\n");
    await rm(SKILL_PATH, { recursive: true });
    await symlink("real-calavera", SKILL_PATH);
    const skill = item(await planEject({ dryRun: true }), SKILL_PATH);
    assert.equal(skill.edits, "cannot-detect");
    assert.equal(skill.matchesRecords, false);
    assert.match(skill.reason ?? "", /edits cannot be detected for: \.agents\/skills\/calavera\.$/);
  });
});

test("an uncovered entry added after the plan stops the removal", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    const plan = await planEject({ dryRun: false });
    assert.equal(item(plan, SKILL_PATH).edits, "unedited");
    await mkdir(`${SKILL_PATH}/drafts`);
    await assert.rejects(
      executeEject(selectEjectItems(plan, { assumeYes: false }).remove),
      /\.agents\/skills\/calavera changed since eject listed/,
    );
    assert.equal(await readFile(`${SKILL_PATH}/SKILL.md`, "utf8"), "# Calavera\n");
  });
});

test("an approved run removes a base skill that has no record", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false, skillRecord: false });
    const outcome = await executeEject(
      selectEjectItems(await planEject({ dryRun: false }), { assumeYes: false }).remove,
    );
    assert.ok(paths(outcome.removed).includes(SKILL_PATH));
  });
});

test(
  "a base skill folder eject cannot read never counts as covered",
  { skip: isRoot },
  async () => {
    await inProject(async () => {
      await writeFootprint({ packageFolder: false });
      await mkdir(`${SKILL_PATH}/private`);
      await write(`${SKILL_PATH}/private/notes.md`, "mine\n");
      const { chmod } = await import("node:fs/promises");
      await chmod(`${SKILL_PATH}/private`, 0o000);
      try {
        const skill = item(await planEject({ dryRun: true }), SKILL_PATH);
        assert.equal(skill.matchesRecords, false);
        assert.match(
          skill.reason ?? "",
          /Calavera could not list every entry of \.agents\/skills\/calavera \(EACCES.*\), so edits cannot be detected for what it could not list\.$/,
        );
        // Only the folder it could not list is named; nothing claims an uncovered entry.
        assert.equal((skill.reason ?? "").includes("does not cover symbolic links"), false);
      } finally {
        await chmod(`${SKILL_PATH}/private`, 0o755);
      }
    });
  },
);

test("a base skill names every uncovered entry, in a stable order", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await symlink("SKILL.md", `${SKILL_PATH}/z-link`);
    await mkdir(`${SKILL_PATH}/a-empty`);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    state.aiArtifacts[0].hash = await hashAiInstall("skill", SKILL_PATH);
    await writeFile(".calavera/state.json", JSON.stringify(state));
    assert.match(
      item(await planEject({ dryRun: true }), SKILL_PATH).reason ?? "",
      /for: \.agents\/skills\/calavera\/a-empty, \.agents\/skills\/calavera\/z-link\.$/,
    );
  });
});

test("a base skill with no record names the entries its hash does not cover", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false, skillRecord: false });
    await mkdir(`${SKILL_PATH}/drafts`);
    assert.equal(
      item(await planEject({ dryRun: true }), SKILL_PATH).reason,
      ".calavera/state.json holds no record of the base Calavera skill, so eject cannot tell whether you edited it. The record's hash does not cover symbolic links or empty folders, so edits cannot be detected for: .agents/skills/calavera/drafts.",
    );
  });
});

test("an approved run removes a base skill that links out of the project, and only the link", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    await write(join(outside.path, "SKILL.md"), "# Theirs\n");
    await rm(SKILL_PATH, { recursive: true });
    await symlink(outside.path, SKILL_PATH);
    const plan = await planEject({ dryRun: false });
    assert.equal(item(plan, SKILL_PATH).matchesRecords, false);
    const outcome = await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
    assert.deepEqual(outcome.failed, []);
    assert.ok(paths(outcome.removed).includes(SKILL_PATH));
    assert.equal(await readFile(join(outside.path, "SKILL.md"), "utf8"), "# Theirs\n");
    await assert.rejects(lstat(SKILL_PATH), { code: "ENOENT" });
  });
});

test("an edit never writes through a symbolic link that leads out of the project", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    await write(join(outside.path, "gitignore"), `node_modules/\n${CACHE_BLOCK}`);
    await rm(".gitignore");
    await symlink(join(outside.path, "gitignore"), ".gitignore");
    await assert.rejects(planEject({ dryRun: true }), /Eject path must stay inside/);
  });
});

// A symbolic link at a path Calavera owns leads to content no record covers, wherever it points,
// so it needs an interactive approval, as a link in place of a package folder does.
for (const path of [
  ".calavera/cache",
  ".calavera/.staging",
  ".calavera/.transactions",
  ".calavera/state.json",
  ".calavera/artifacts.lock.json",
]) {
  test(`a symbolic link at ${path} needs an interactive approval, and only the link goes`, async () => {
    await inProject(async () => {
      await writeFootprint({ packageFolder: false });
      await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
      const original = await readFile(path).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
      const linkTarget = join(outside.path, "target");
      if (original === undefined) {
        await write(join(linkTarget, "kept"), "theirs\n");
      } else {
        await write(linkTarget, original.toString());
      }
      await symlink(linkTarget, path);

      const plan = await planEject({ dryRun: false });
      const linked = item(plan, path);
      assert.equal(linked.edits, "cannot-detect");
      assert.equal(linked.matchesRecords, false);
      assert.equal(
        linked.reason,
        `${path} is a symbolic link, which no record covers; edits cannot be detected. eject removes only the link, not what it leads to.`,
      );
      assert.ok(paths(selectEjectItems(plan, { assumeYes: true }).leave).includes(path));

      const outcome = await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
      assert.deepEqual(outcome.failed, []);
      await assert.rejects(lstat(path), { code: "ENOENT" });
      assert.ok((await lstat(linkTarget)) !== undefined);
    });
  });
}

test("--yes keeps the cache block while it leaves a linked cache", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    await rm(".calavera/cache", { recursive: true });
    await symlink(outside.path, ".calavera/cache");
    const { leave } = selectEjectItems(await planEject({ dryRun: false }), { assumeYes: true });
    // Removing the block would show the cache in `git status`, and the state records the block.
    assert.deepEqual(paths(leave), [
      ".calavera/cache",
      ".calavera/state.json",
      ".gitignore",
      "calavera.config.json",
    ]);
  });
});

test("an item the person removed between the plan and the removal counts as removed", async () => {
  await inProject(async () => {
    await writeFootprint();
    const plan = await planEject({ dryRun: false });
    await rm(".calavera/cache", { recursive: true });
    await rm(SKILL_PATH, { recursive: true });
    await rm(PACKAGE_ROOT, { recursive: true });
    const outcome = await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
    assert.deepEqual(outcome.failed, []);
    assert.deepEqual(outcome.skipped, []);
    assert.deepEqual(paths(outcome.removed), paths(plan.items));
    assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");
    await assert.rejects(lstat(".calavera"), { code: "ENOENT" });
  });
});

for (const [label, swap] of [
  ["a real folder", async (/** @type {string} */ path) => write(`${path}/theirs.txt`, "mine\n")],
  [
    "a link that points elsewhere",
    async (/** @type {string} */ path) => symlink("elsewhere", path),
  ],
]) {
  test(`a linked cache replaced by ${label} after the plan is not removed`, async () => {
    await inProject(async () => {
      await writeFootprint({ packageFolder: false });
      await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
      await rm(".calavera/cache", { recursive: true });
      await symlink(outside.path, ".calavera/cache");
      const plan = await planEject({ dryRun: false });
      await rm(".calavera/cache");
      await swap(".calavera/cache");
      const before = await snapshotDirectory();
      await assert.rejects(
        executeEject(selectEjectItems(plan, { assumeYes: false }).remove),
        /eject stopped before removing anything, because \.calavera\/cache changed since eject listed/,
      );
      assert.deepEqual(await snapshotDirectory(), before);
    });
  });
}

test("--yes keeps no record for a linked cache when there is no artifact-cache block", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false, gitignore: "node_modules/\n" });
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    await rm(".calavera/cache", { recursive: true });
    await symlink(outside.path, ".calavera/cache");
    const { leave } = selectEjectItems(await planEject({ dryRun: false }), { assumeYes: true });
    assert.deepEqual(paths(leave), [".calavera/cache", "calavera.config.json"]);
  });
});

test("a real cache replaced by a link after the plan is not removed", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    await write("mine/kept.txt", "mine\n");
    const plan = await planEject({ dryRun: false });
    assert.equal(item(plan, ".calavera/cache").matchesRecords, true);
    await rm(".calavera/cache", { recursive: true });
    await symlink("../mine", ".calavera/cache");
    const before = await snapshotDirectory();
    await assert.rejects(
      executeEject(selectEjectItems(plan, { assumeYes: true }).remove),
      /eject stopped before removing anything, because \.calavera\/cache changed since eject listed/,
    );
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("a .gitignore whose first line starts with link: is removed as planned", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false, gitignore: `link:notes\n${CACHE_BLOCK}` });
    const outcome = await executeEject(
      selectEjectItems(await planEject({ dryRun: false }), { assumeYes: false }).remove,
    );
    assert.deepEqual(outcome.failed, []);
    assert.equal(await readFile(".gitignore", "utf8"), "link:notes\n");
  });
});

for (const [label, folder] of [
  ["a package folder a lock entry names", PACKAGE_ROOT],
  ["a package folder no lock entry names", ".calavera/packages/skill-retired/1.0.0"],
]) {
  test(`${label} replaced by a link after the plan is not removed`, async () => {
    await inProject(async () => {
      await writeFootprint();
      await write(".calavera/packages/skill-retired/1.0.0/package.json", "{}\n");
      await write("mine/kept.txt", "mine\n");
      const plan = await planEject({ dryRun: false });
      await rm(folder, { recursive: true });
      await symlink(join(process.cwd(), "mine"), folder);
      const before = await snapshotDirectory();
      await assert.rejects(
        executeEject(selectEjectItems(plan, { assumeYes: false }).remove),
        new RegExp(`because ${folder.replaceAll(".", "\\.").replaceAll("/", "\\/")} changed since`),
      );
      assert.deepEqual(await snapshotDirectory(), before);
    });
  });
}

test("a .gitignore the person deleted after the plan counts as removed", async () => {
  await inProject(async () => {
    await writeFootprint({ packageFolder: false });
    const plan = await planEject({ dryRun: false });
    await rm(".gitignore");
    const outcome = await executeEject(selectEjectItems(plan, { assumeYes: false }).remove);
    assert.deepEqual(outcome.failed, []);
    assert.deepEqual(outcome.skipped, []);
    assert.ok(paths(outcome.removed).includes(".gitignore"));
    await assert.rejects(lstat(".gitignore"), { code: "ENOENT" });
    await assert.rejects(lstat(".calavera"), { code: "ENOENT" });
  });
});
