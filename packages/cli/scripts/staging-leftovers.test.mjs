// Issue #1034: releases before #988 left a `.calavera/.staging/<id>` folder after restoring a
// locked package. Apply removes such a folder only when its contents match a package the lock
// records, and reports every other entry of `.calavera/.staging/` without removing it (owner
// decision of 2026-11-18). The dry run lists both, and apply checks each folder again just before
// it removes it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsPromises, {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import {
  STAGING_ROOT,
  planStagingLeftovers,
  removeStagingLeftovers,
} from "../src/staging-leftovers.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";

const ID = "skill-project-goal";
const VERSION = "0.1.0";
const LEFTOVER = `${STAGING_ROOT}/${ID}`;
const PACKAGE = `${artifactForId(ID)?.packageName}@${VERSION}`;

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

const recipe = { ...buildRecipe("minimal", [], "npm"), ai: [{ id: ID }] };

/**
 * Runs `callback` in a new project where apply has installed and locked `skill-project-goal`.
 *
 * @param {(registry: ReturnType<typeof stubRegistry>) => Promise<void>} callback
 */
async function inInstalledProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-staging-leftovers-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    await writeFile("package.json", `${JSON.stringify({ name: "fixture", scripts: {} })}\n`);
    const registry = stubRegistry(new Map([[ID, VERSION]]));
    await applyRecipeObject(recipe, applyOptions, registry);
    await callback(registry);
  } finally {
    // A test that made a folder read-only must not stop the temporary project's removal.
    await chmod(join(project.path, STAGING_ROOT), 0o755).catch(() => {});
    process.chdir(originalDirectory);
  }
}

/**
 * Writes the folder a release before #988 left: the locked package exactly as it was extracted,
 * which apply then copied into `.calavera/packages/<id>/<version>/`.
 */
async function writeOldStagingFolder(path = LEFTOVER) {
  await mkdir(STAGING_ROOT, { recursive: true });
  await cp(`.calavera/packages/${ID}/${VERSION}`, path, { recursive: true });
}

/** @param {string} path */
async function exists(path) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** @param {import("../src/index.js").ApplyResult} result @param {string} path */
function leftover(result, path) {
  const item = result.stagingLeftovers.find((candidate) => candidate.path === path);
  assert.ok(item, `${path} is not reported`);
  return item;
}

test("apply --dry-run lists an old staging folder that matches the locked package, and apply removes it and the emptied .calavera/.staging", async () => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    const before = await snapshot();

    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry);

    assert.deepEqual(await snapshot(), before, "the dry run changed the project");
    assert.equal(leftover(dryRun, LEFTOVER).action, "remove");
    assert.match(leftover(dryRun, LEFTOVER).reason, /^A copy of .+ that an earlier release/);
    assert.equal(leftover(dryRun, LEFTOVER).package, PACKAGE);

    const applied = await applyRecipeObject(recipe, applyOptions, registry);

    assert.deepEqual(applied.stagingLeftovers, [
      {
        path: LEFTOVER,
        action: "remove",
        package: PACKAGE,
        reason: leftover(dryRun, LEFTOVER).reason,
      },
    ]);
    assert.equal(await exists(STAGING_ROOT), false, ".calavera/.staging was left behind");
    // The package itself is untouched.
    assert.equal((await stat(`.calavera/packages/${ID}/${VERSION}`)).isDirectory(), true);
  });
});

test("apply keeps and reports an old staging folder whose contents differ from the locked package", async (t) => {
  const cases = [
    {
      name: "an edited file",
      change: async () => {
        const [first] = await readdir(LEFTOVER, { recursive: true, withFileTypes: true }).then(
          (entries) => entries.filter((entry) => entry.isFile()),
        );
        await writeFile(join(first.parentPath, first.name), "my own notes\n");
      },
    },
    { name: "an extra file", change: () => writeFile(`${LEFTOVER}/notes.md`, "mine\n") },
    { name: "an extra empty folder", change: () => mkdir(`${LEFTOVER}/mine`) },
    {
      name: "a symbolic link",
      change: () => symlink("../../../package.json", `${LEFTOVER}/link`),
    },
    {
      // Without the check of the entry's type, the link's target would be read, and its bytes
      // match the file it replaces.
      name: "a file replaced by a symbolic link to the same bytes",
      change: async () => {
        const [first] = await readdir(LEFTOVER, { recursive: true, withFileTypes: true }).then(
          (entries) => entries.filter((entry) => entry.isFile()),
        );
        const file = join(first.parentPath, first.name);
        await cp(file, "same-bytes");
        await rm(file);
        await symlink(join(process.cwd(), "same-bytes"), file);
      },
    },
    {
      name: "a missing file",
      change: async () => {
        const [first] = await readdir(LEFTOVER, { recursive: true, withFileTypes: true }).then(
          (entries) => entries.filter((entry) => entry.isFile()),
        );
        await rm(join(first.parentPath, first.name));
      },
    },
  ];
  for (const { name, change } of cases) {
    await t.test(name, async () => {
      await inInstalledProject(async (registry) => {
        await writeOldStagingFolder();
        await change();
        const before = await snapshot(STAGING_ROOT);

        const applied = await applyRecipeObject(recipe, applyOptions, registry);

        assert.equal(leftover(applied, LEFTOVER).action, "keep");
        assert.match(leftover(applied, LEFTOVER).reason, /differ/);
        assert.deepEqual(await snapshot(STAGING_ROOT), before, "apply changed the folder");
      });
    });
  }
});

test("apply keeps and reports every entry of .calavera/.staging that is not a copy of a locked package", async () => {
  await inInstalledProject(async (registry) => {
    await mkdir(STAGING_ROOT, { recursive: true });
    // An interrupted eject's holder, a folder no lock entry names, and a file.
    await mkdir(`${STAGING_ROOT}/eject-a1b2c3/package`, { recursive: true });
    await writeFile(`${STAGING_ROOT}/eject-a1b2c3/package/file`, "x\n");
    await mkdir(`${STAGING_ROOT}/skill-not-locked`);
    await writeFile(`${STAGING_ROOT}/notes.txt`, "mine\n");
    // A link named after the locked package is never followed.
    await symlink(`../packages/${ID}/${VERSION}`, LEFTOVER);
    const before = await snapshot(STAGING_ROOT);

    const applied = await applyRecipeObject(recipe, applyOptions, registry);

    assert.deepEqual(
      applied.stagingLeftovers.map(({ path, action }) => [path, action]),
      [
        [`${STAGING_ROOT}/eject-a1b2c3`, "keep"],
        [`${STAGING_ROOT}/notes.txt`, "keep"],
        [`${STAGING_ROOT}/skill-not-locked`, "keep"],
        [LEFTOVER, "keep"],
      ],
    );
    assert.match(leftover(applied, LEFTOVER).reason, /^It is a symbolic link, /);
    assert.match(leftover(applied, `${STAGING_ROOT}/notes.txt`).reason, /^It is a file, /);
    assert.match(
      leftover(applied, `${STAGING_ROOT}/skill-not-locked`).reason,
      /no package the lock records/i,
    );
    assert.deepEqual(await snapshot(STAGING_ROOT), before, "apply changed .calavera/.staging");
  });
});

test("apply keeps the matching folder's siblings and .calavera/.staging when it removes the match", async () => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    await writeFile(`${STAGING_ROOT}/notes.txt`, "mine\n");

    const applied = await applyRecipeObject(recipe, applyOptions, registry);

    assert.equal(leftover(applied, LEFTOVER).action, "remove");
    assert.equal(await exists(LEFTOVER), false);
    assert.deepEqual(await readdir(STAGING_ROOT), ["notes.txt"]);
  });
});

test("apply keeps an old staging folder when the package it rebuilds does not match the lock's payload hash", async () => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    const lockPath = ".calavera/artifacts.lock.json";
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    // The lock no longer describes the files the folder holds, so nothing shows Calavera wrote them.
    lock.artifacts[0].payloadHash = "0".repeat(64);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const result = await applyRecipeObject(
      { ...recipe, ai: [] },
      { ...applyOptions, dryRun: true },
      registry,
    );

    assert.equal(leftover(result, LEFTOVER).action, "keep");
    // The mismatch has no error code, so the reason names none.
    assert.match(
      leftover(result, LEFTOVER).reason,
      /could not rebuild .+ from the artifact cache to compare it with\. Remove it yourself/,
    );
  });
});

test("apply keeps and reports an old staging folder when the locked package cannot be rebuilt to compare it, and still completes", async () => {
  await inInstalledProject(async () => {
    await writeOldStagingFolder();
    const failing = stubRegistry(new Map(), {
      failFor: ID,
      error: Object.assign(new Error("secret-token-in-message"), { code: "ENOTCACHED" }),
    });

    const applied = await applyRecipeObject(recipe, applyOptions, failing);

    const item = leftover(applied, LEFTOVER);
    assert.equal(item.action, "keep");
    assert.match(item.reason, /could not rebuild/);
    assert.match(item.reason, /ENOTCACHED/);
    assert.doesNotMatch(item.reason, /secret-token-in-message/);
    assert.equal(await exists(LEFTOVER), true);
  });
});

test("apply does not look inside a .calavera/.staging that is a symbolic link", async () => {
  await inInstalledProject(async (registry) => {
    await using elsewhere = await mkdtempDisposable(join(tmpdir(), "calavera-staging-target-"));
    await cp(`.calavera/packages/${ID}/${VERSION}`, join(elsewhere.path, ID), { recursive: true });
    await symlink(elsewhere.path, STAGING_ROOT);

    const applied = await applyRecipeObject(recipe, applyOptions, registry);

    assert.deepEqual(
      applied.stagingLeftovers.map(({ path, action }) => [path, action]),
      [[STAGING_ROOT, "keep"]],
    );
    assert.match(leftover(applied, STAGING_ROOT).reason, /symbolic link/);
    assert.equal((await stat(join(elsewhere.path, ID))).isDirectory(), true);
  });
});

test("when removing an old staging folder fails, apply still completes and reports the folder as kept", async () => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    await chmod(STAGING_ROOT, 0o555);

    const applied = await applyRecipeObject(recipe, applyOptions, registry);

    const item = leftover(applied, LEFTOVER);
    assert.equal(item.action, "keep");
    assert.match(item.reason, /could not remove/);
    assert.match(item.reason, /EACCES|EPERM/);
  });
});

test("a folder that changes after the plan is kept, not removed", async () => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    const plan = await planStagingLeftovers({ dryRun: false, services: registry });
    assert.equal(plan.items[0].action, "remove");
    await writeFile(`${LEFTOVER}/added-after-the-plan.md`, "mine\n");

    const items = await removeStagingLeftovers(plan);

    assert.equal(items[0].action, "keep");
    assert.match(items[0].reason, /changed after/);
    assert.equal(await exists(`${LEFTOVER}/added-after-the-plan.md`), true);
  });
});

test("a folder replaced by a symbolic link after the plan is kept, and the link is not followed", async () => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    const plan = await planStagingLeftovers({ dryRun: false, services: registry });
    await using elsewhere = await mkdtempDisposable(join(tmpdir(), "calavera-staging-swap-"));
    await cp(LEFTOVER, join(elsewhere.path, "copy"), { recursive: true });
    await rm(LEFTOVER, { recursive: true });
    await symlink(join(elsewhere.path, "copy"), LEFTOVER);

    const items = await removeStagingLeftovers(plan);

    assert.equal(items[0].action, "keep");
    assert.equal((await lstat(LEFTOVER)).isSymbolicLink(), true);
    assert.equal((await stat(join(elsewhere.path, "copy"))).isDirectory(), true);
  });
});

test("apply reports nothing when .calavera/.staging does not exist, and leaves an empty one in place", async () => {
  await inInstalledProject(async (registry) => {
    const without = await applyRecipeObject(recipe, applyOptions, registry);
    assert.deepEqual(without.stagingLeftovers, []);

    await mkdir(STAGING_ROOT);
    const empty = await applyRecipeObject(recipe, applyOptions, registry);
    assert.deepEqual(empty.stagingLeftovers, []);
    assert.deepEqual(await readdir(STAGING_ROOT), []);
  });
});

test("apply keeps and reports an entry that is neither a file, a folder, nor a symbolic link", async () => {
  await inInstalledProject(async (registry) => {
    await mkdir(STAGING_ROOT);
    execFileSync("mkfifo", [`${STAGING_ROOT}/pipe`]);

    const applied = await applyRecipeObject(recipe, applyOptions, registry);

    assert.match(leftover(applied, `${STAGING_ROOT}/pipe`).reason, /^It is not a folder, /);
    assert.equal(await exists(`${STAGING_ROOT}/pipe`), true);
  });
});

test("the dry run and apply remove the temporary folders they rebuild the locked package in", async (t) => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    const mkdtemp = fsPromises.mkdtemp;
    /** @type {string[]} */
    const folders = [];
    t.mock.method(fsPromises, "mkdtemp", async (/** @type {string} */ prefix, ...rest) => {
      const folder = await mkdtemp(prefix, ...rest);
      if (prefix.includes("calavera-staging-check-")) folders.push(folder);
      return folder;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry);
    await applyRecipeObject(recipe, applyOptions, registry);

    assert.equal(folders.length, 2, "each run rebuilds the package once");
    for (const folder of folders) {
      assert.equal(await exists(folder), false, `${folder} was left behind`);
    }
  });
});

test("a .calavera/.staging replaced by a symbolic link after the plan is not followed", async () => {
  await inInstalledProject(async (registry) => {
    await writeOldStagingFolder();
    const plan = await planStagingLeftovers({ dryRun: false, services: registry });
    await using elsewhere = await mkdtempDisposable(join(tmpdir(), "calavera-staging-root-swap-"));
    await cp(STAGING_ROOT, join(elsewhere.path, "staging"), { recursive: true });
    await rm(STAGING_ROOT, { recursive: true });
    await symlink(join(elsewhere.path, "staging"), STAGING_ROOT);

    const items = await removeStagingLeftovers(plan);

    assert.equal(items[0].action, "keep");
    assert.equal((await stat(join(elsewhere.path, "staging", ID))).isDirectory(), true);
  });
});
