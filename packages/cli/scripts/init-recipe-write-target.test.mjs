// #1220: init writes the recipe itself, before it applies, so it runs the same #1208 check as
// apply before that write. A link at the recipe path, or at a folder on the way to it, never makes
// init or init --apply create or change a file outside the project. Every refusal is a real init,
// which writes the recipe, and leaves the project and the outside folder byte-identical.
import assert from "node:assert/strict";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { initRecipe } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { snapshotDirectory } from "./project-snapshot.mjs";
import { createTemporaryFixture, json, plainViteManifest } from "./vite-plus-fixtures.mjs";

// A file symbolic link on Windows needs Developer Mode or an extra privilege.
const fileLinkSkip = { skip: process.platform === "win32" };

/** A project with its own package.json, and a folder outside it. */
async function projectAndElsewhere() {
  const project = await createTemporaryFixture("init-recipe-write-project", {
    "package.json": json(plainViteManifest),
    "configs/keep.txt": "keep\n",
  });
  await mkdir(join(project.root, ".git"));
  const elsewhere = await createTemporaryFixture("init-recipe-write-elsewhere", {
    "shared.json": json(buildRecipe("minimal", ["editorconfig"], "pnpm", [], {})),
  });
  return {
    root: project.root,
    elsewhere: elsewhere.root,
    async [Symbol.asyncDispose]() {
      await project[Symbol.asyncDispose]();
      await elsewhere[Symbol.asyncDispose]();
    },
  };
}

/**
 * Runs a real init in `directory`, with every answer given, that writes the recipe at `config`.
 *
 * @param {string} directory
 * @param {string} config
 * @param {{ apply: boolean, dryRun?: boolean }} mode
 */
async function initIn(directory, config, { apply, dryRun = false }) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await initRecipe({
      command: "init",
      config,
      dryRun,
      json: true,
      noInstall: true,
      assumeYes: true,
      apply,
      profile: "minimal",
      packageManager: "pnpm",
      integrations: ["editorconfig"],
      aiArtifacts: [],
    });
  } finally {
    process.chdir(previous);
  }
}

/**
 * Runs a real init and init --apply that write the recipe at `config`, and the same two as dry
 * runs, which run the check too, as apply's dry run does. Asserts that each stops and leaves both
 * folders byte-identical, and returns each message.
 *
 * @param {{ root: string, elsewhere: string }} fixture
 * @param {string} config
 */
async function refusals(fixture, config) {
  /** @type {string[]} */
  const messages = [];
  for (const [apply, dryRun] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const mode = `apply ${apply}, dry run ${dryRun}`;
    const before = await snapshotDirectory(fixture.root);
    const elsewhereBefore = await snapshotDirectory(fixture.elsewhere);
    const error = await initIn(fixture.root, config, { apply, dryRun }).then(
      () => assert.fail(`init (${mode}) did not stop on ${config}`),
      (/** @type {unknown} */ failure) => failure,
    );
    assert.ok(error instanceof Error);
    assert.deepEqual(await snapshotDirectory(fixture.root), before, mode);
    assert.deepEqual(await snapshotDirectory(fixture.elsewhere), elsewhereBefore, mode);
    assert.match(error.message, /Calavera stopped before writing anything\.$/);
    messages.push(error.message);
  }
  return messages;
}

test(
  "init refuses a recipe path that is a dangling link to a path outside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    const target = join(fixture.elsewhere, "created.json");
    await symlink(target, link);

    for (const message of await refusals(fixture, "calavera.config.json")) {
      assert.ok(
        message.includes(
          `${link} is a link to ${target}, which does not exist and is outside ${fixture.root}, so writing the recipe would create ${target} instead.`,
        ),
        message,
      );
    }
  },
);

test(
  "init refuses a recipe path that is a dangling link to a path inside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    const target = join(fixture.root, "configs", "recipe.json");
    await symlink(target, link);

    for (const message of await refusals(fixture, "calavera.config.json")) {
      assert.ok(
        message.includes(
          `${link} is a link to ${target}, which does not exist, so writing the recipe would create ${target} instead.`,
        ),
        message,
      );
    }
  },
);

test(
  "init refuses a recipe path that links to an existing file outside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    const target = join(fixture.elsewhere, "shared.json");
    await symlink(target, link);

    for (const message of await refusals(fixture, "calavera.config.json")) {
      assert.ok(
        message.includes(
          `${link} is a link to ${target}, which is outside ${fixture.root}, so writing the recipe would change a file outside the project.`,
        ),
        message,
      );
    }
  },
);

test("init refuses a recipe path that a folder link leads outside the project", async () => {
  await using fixture = await projectAndElsewhere();
  await symlink(fixture.elsewhere, join(fixture.root, "via"), "junction");

  for (const [name, verb] of [
    ["created.json", "create"],
    ["shared.json", "change"],
  ]) {
    for (const message of await refusals(fixture, join("via", name))) {
      assert.ok(
        message.includes(
          `${join(fixture.root, "via", name)} resolves to ${join(fixture.elsewhere, name)}, which is outside ${fixture.root}, so writing the recipe would ${verb} a file outside the project.`,
        ),
        message,
      );
    }
  }
});

test(
  "init writes the recipe through a link to an existing file inside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const target = join(fixture.root, "configs", "recipe.json");
    await initIn(fixture.root, join("configs", "recipe.json"), { apply: false });
    const link = join(fixture.root, "calavera.config.json");
    await symlink(target, link);
    const elsewhereBefore = await snapshotDirectory(fixture.elsewhere);

    const { recipe } = await initIn(fixture.root, "calavera.config.json", { apply: false });

    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), recipe);
    assert.deepEqual(await snapshotDirectory(fixture.elsewhere), elsewhereBefore);
  },
);
