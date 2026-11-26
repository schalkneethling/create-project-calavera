// #1220: init writes the recipe itself, before it applies, so it runs the same #1208 check as
// apply before that write. A link at the recipe path, or at a folder on the way to it, never makes
// init or init --apply create or change a file outside the project. Every refusal runs a real init,
// which would write the recipe, and its dry run, and leaves the project and the outside folder
// byte-identical.
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
 * runs, which run the check too, as apply's dry run does. Asserts that each stops, leaves both
 * folders byte-identical, and tells the person to run init again, and returns each message.
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
    // Init stopped before it wrote the recipe, so the remedy names init, not apply.
    assert.match(
      error.message,
      / then run init again\. Calavera stopped before writing anything\.$/,
    );
    assert.doesNotMatch(error.message, /run apply/);
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

// The same check also stops a plain recipe path outside the project and a path in a folder that
// does not exist, which init wrote, or failed on with a raw ENOENT, before #1220.
test("init refuses a recipe path outside the project", async () => {
  await using fixture = await projectAndElsewhere();
  const given = join(fixture.elsewhere, "named.json");

  for (const message of await refusals(fixture, given)) {
    assert.ok(
      message.includes(
        `${given} is outside ${fixture.root}, so writing the recipe would create a file outside the project.`,
      ),
      message,
    );
  }
});

test("init names the recipe path when its folder does not exist", async () => {
  await using fixture = await projectAndElsewhere();
  const given = join(fixture.root, "missing", "recipe.json");

  for (const message of await refusals(fixture, join("missing", "recipe.json"))) {
    assert.ok(
      message.startsWith(
        `Calavera cannot write the recipe at ${given}, because the folder ${join(fixture.root, "missing")} does not exist.`,
      ),
      message,
    );
  }
});

test("init names the recipe path when it is a folder or links to one", fileLinkSkip, async () => {
  await using fixture = await projectAndElsewhere();
  const folder = join(fixture.root, "configs");
  await symlink(folder, join(fixture.root, "folder-link.json"));

  for (const [config, why] of [
    ["configs", `${folder} is a folder.`],
    ["folder-link.json", `it leads to ${folder}, which is a folder.`],
  ]) {
    for (const message of await refusals(fixture, config)) {
      assert.ok(
        message.startsWith(
          `Calavera cannot write the recipe at ${join(fixture.root, config)}, because ${why}`,
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
