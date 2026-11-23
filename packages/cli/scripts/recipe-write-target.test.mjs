// #1208: apply writes the recipe only where its path names. A link at the recipe path, or at a
// folder on the way to it, never makes apply create or change a file outside the project, and a
// folder that does not exist stops with a Calavera error instead of a raw ENOENT. Every refusal is
// a real apply, with writeConfig true, and leaves the project and every outside folder unchanged.
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { snapshotDirectory } from "./project-snapshot.mjs";
import { createTemporaryFixture, json, plainViteManifest } from "./vite-plus-fixtures.mjs";

const recipe = buildRecipe("minimal", ["editorconfig"], "pnpm", [], {});

// A file symbolic link on Windows needs Developer Mode or an extra privilege.
const fileLinkSkip = { skip: process.platform === "win32" };

/** A project with its own package.json, and a folder outside it. */
async function projectAndElsewhere() {
  const project = await createTemporaryFixture("recipe-write-project", {
    "package.json": json(plainViteManifest),
    "configs/keep.txt": "keep\n",
  });
  await mkdir(join(project.root, ".git"));
  const elsewhere = await createTemporaryFixture("recipe-write-elsewhere", {
    "shared.json": json(recipe),
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
 * Runs a real apply in `directory` that writes the recipe at `config`, and returns the error it
 * stops with.
 *
 * @param {string} directory
 * @param {string} config
 * @param {Record<string, unknown>} [options]
 */
async function refusal(directory, config, options = {}) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    await applyRecipeObject(structuredClone(recipe), {
      assumeYes: true,
      noInstall: true,
      writeConfig: true,
      config,
      ...options,
    });
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  } finally {
    process.chdir(previous);
  }
  assert.fail(`apply did not stop on ${config}`);
}

/**
 * Runs a real apply in `directory` that writes the recipe, and returns its result.
 *
 * @param {string} directory
 * @param {Record<string, unknown>} [options]
 */
async function applyIn(directory, options = {}) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await applyRecipeObject(structuredClone(recipe), {
      assumeYes: true,
      noInstall: true,
      writeConfig: true,
      ...options,
    });
  } finally {
    process.chdir(previous);
  }
}

/**
 * Asserts that `run` leaves both folders exactly as they were.
 *
 * @param {{ root: string, elsewhere: string }} fixture
 * @param {() => Promise<Error>} run
 */
async function unchanged(fixture, run) {
  const before = await snapshotDirectory(fixture.root);
  const elsewhereBefore = await snapshotDirectory(fixture.elsewhere);
  const error = await run();
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
  assert.deepEqual(await snapshotDirectory(fixture.elsewhere), elsewhereBefore);
  return error;
}

test(
  "apply refuses a recipe path that is a dangling link to a path outside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    const target = join(fixture.elsewhere, "created.json");
    await symlink(target, link);

    for (const dryRun of [false, true]) {
      const { message } = await unchanged(fixture, () =>
        refusal(fixture.root, "calavera.config.json", { dryRun }),
      );
      assert.ok(
        message.includes(
          `${link} is a link to ${target}, which does not exist and is outside ${fixture.root}, so writing the recipe would create ${target} instead.`,
        ),
        message,
      );
      assert.match(message, /Remove the link, or point it at an existing file inside /);
      assert.match(message, /Calavera stopped before writing anything\.$/);
    }
  },
);

test(
  "apply refuses a recipe path that is a dangling link to a path inside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    const target = join(fixture.root, "configs", "recipe.json");
    await symlink(target, link);

    const { message } = await unchanged(fixture, () =>
      refusal(fixture.root, "calavera.config.json"),
    );
    assert.ok(
      message.includes(
        `${link} is a link to ${target}, which does not exist, so writing the recipe would create ${target} instead.`,
      ),
      message,
    );
  },
);

test(
  "apply refuses a recipe path that links to an existing file outside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    const target = join(fixture.elsewhere, "shared.json");
    await symlink(target, link);

    const { message } = await unchanged(fixture, () =>
      refusal(fixture.root, "calavera.config.json"),
    );
    assert.ok(
      message.includes(
        `${link} is a link to ${target}, which is outside ${fixture.root}, so writing the recipe would change a file outside the project.`,
      ),
      message,
    );
    assert.match(message, /Replace the link with the recipe file itself/);
  },
);

test("apply refuses a recipe path that a folder link leads outside the project", async () => {
  await using fixture = await projectAndElsewhere();
  await symlink(fixture.elsewhere, join(fixture.root, "via"), "junction");

  for (const [name, verb] of [
    ["created.json", "create"],
    ["shared.json", "change"],
  ]) {
    const { message } = await unchanged(fixture, () => refusal(fixture.root, join("via", name)));
    assert.ok(
      message.includes(
        `${join(fixture.root, "via", name)} reaches ${join(fixture.elsewhere, name)} through a folder link, which is outside ${fixture.root}, so writing the recipe would ${verb} a file outside the project.`,
      ),
      message,
    );
  }
});

test(
  "apply calls a dangling link outside the project when a folder on the way leads out",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    await symlink(fixture.elsewhere, join(fixture.root, "via"), "junction");
    const link = join(fixture.root, "calavera.config.json");

    // The first target reaches outside through the folder link; the second is in a folder outside
    // that does not exist yet, so the check walks up to the nearest folder that does.
    for (const target of [
      join(fixture.root, "via", "created.json"),
      join(fixture.elsewhere, "new", "deeper", "created.json"),
    ]) {
      await rm(link, { force: true });
      await symlink(target, link);
      const { message } = await unchanged(fixture, () =>
        refusal(fixture.root, "calavera.config.json"),
      );
      assert.ok(
        message.includes(
          `${link} is a link to ${target}, which does not exist and is outside ${fixture.root},`,
        ),
        message,
      );
    }
  },
);

test(
  "apply names the real path when the recipe link reaches outside through another link",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const alias = join(fixture.elsewhere, "alias.json");
    await symlink(join(fixture.elsewhere, "shared.json"), alias);
    const link = join(fixture.root, "calavera.config.json");
    await symlink(alias, link);

    const { message } = await unchanged(fixture, () =>
      refusal(fixture.root, "calavera.config.json"),
    );
    assert.ok(
      message.includes(
        `${link} is a link to ${alias}, at the real path ${join(fixture.elsewhere, "shared.json")}, which is outside ${fixture.root}`,
      ),
      message,
    );
  },
);

test("apply names the recipe path when its folder is a link to a missing folder", async () => {
  await using fixture = await projectAndElsewhere();
  const missing = join(fixture.elsewhere, "gone");
  await symlink(missing, join(fixture.root, "gone"), "junction");
  const given = join(fixture.root, "gone", "recipe.json");

  const error = await unchanged(fixture, () => refusal(fixture.root, join("gone", "recipe.json")));
  assert.ok(
    error.message.startsWith(
      `Calavera cannot write the recipe at ${given}, because ${join(fixture.root, "gone")} is a link to ${missing}, which does not exist.`,
    ),
    error.message,
  );
  // The file system's code and error stay on the Calavera error for debugging.
  assert.equal(/** @type {NodeJS.ErrnoException} */ (error).code, "ENOENT");
  assert.equal(/** @type {NodeJS.ErrnoException} */ (error.cause).code, "ENOENT");
});

test("apply names the recipe path when its folder does not exist", async () => {
  await using fixture = await projectAndElsewhere();
  const given = join(fixture.root, "missing", "recipe.json");

  const { message } = await unchanged(fixture, () =>
    refusal(fixture.root, join("missing", "recipe.json")),
  );
  assert.ok(
    message.startsWith(
      `Calavera cannot write the recipe at ${given}, because the folder ${join(fixture.root, "missing")} does not exist. Create the folder, or give a recipe path in a folder that exists and can be opened, then run apply again.`,
    ),
    message,
  );
});

test("apply names the recipe path when a folder on the way is a file", async () => {
  await using fixture = await projectAndElsewhere();
  const given = join(fixture.root, "package.json", "recipe.json");

  const error = await unchanged(fixture, () =>
    refusal(fixture.root, join("package.json", "recipe.json")),
  );
  assert.ok(
    error.message.startsWith(
      `Calavera cannot write the recipe at ${given}, because ${join(fixture.root, "package.json")} is not a folder.`,
    ),
    error.message,
  );
  assert.equal(/** @type {NodeJS.ErrnoException} */ (error).code, "ENOTDIR");
});

test(
  "apply names the recipe path when its folder cannot be opened",
  // Windows has no permission bits, and root opens any folder.
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    await using fixture = await projectAndElsewhere();
    const locked = join(fixture.root, "locked");
    await mkdir(locked, { mode: 0o000 });
    try {
      const { message, code } = /** @type {NodeJS.ErrnoException} */ (
        await refusal(fixture.root, join("locked", "recipe.json"))
      );
      assert.ok(
        message.startsWith(
          `Calavera cannot write the recipe at ${join(locked, "recipe.json")}, because the folder ${locked} cannot be opened (EACCES).`,
        ),
        message,
      );
      assert.equal(code, "EACCES");
    } finally {
      await chmod(locked, 0o755);
    }
    assert.deepEqual(await readdir(locked), []);
  },
);

test("apply writes a recipe path outside the project that no link redirects as given", async () => {
  await using fixture = await projectAndElsewhere();
  const given = join(fixture.elsewhere, "named.json");

  await applyIn(fixture.root, { config: given });
  assert.deepEqual(JSON.parse(await readFile(given, "utf8")).integrations, recipe.integrations);
});

test(
  "apply refuses a recipe link outside the project when the path names the project by another route",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    await symlink(join(fixture.elsewhere, "shared.json"), link);
    await symlink(fixture.root, join(fixture.elsewhere, "project-alias"), "junction");
    const given = join(fixture.elsewhere, "project-alias", "calavera.config.json");

    // The path as given is outside the project, but its folder is the project, so the link is held
    // to the project as if the path had named it directly.
    const { message } = await unchanged(fixture, () => refusal(fixture.root, given));
    assert.ok(
      message.includes(
        `${given} is a link to ${join(fixture.elsewhere, "shared.json")}, which is outside ${fixture.root}`,
      ),
      message,
    );
  },
);

test(
  "apply that does not write the recipe leaves a link to a file outside the project alone",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const link = join(fixture.root, "calavera.config.json");
    await symlink(join(fixture.elsewhere, "shared.json"), link);
    const elsewhereBefore = await snapshotDirectory(fixture.elsewhere);

    const result = await applyIn(fixture.root, { writeConfig: false });
    assert.equal(
      result.changes.some(({ path }) => path === "calavera.config.json"),
      false,
    );
    assert.equal(
      (await snapshotDirectory(fixture.root))[link],
      `link to ${join(fixture.elsewhere, "shared.json")}`,
    );
    assert.deepEqual(await snapshotDirectory(fixture.elsewhere), elsewhereBefore);
  },
);

test(
  "apply leaves an unchanged recipe behind a link to a file outside the project alone",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const recipePath = join(fixture.root, "calavera.config.json");
    await applyIn(fixture.root);
    // The recipe the first apply wrote moves outside, behind a link, with the same bytes.
    const shared = join(fixture.elsewhere, "written.json");
    await writeFile(shared, await readFile(recipePath));
    await rm(recipePath);
    await symlink(shared, recipePath);
    const before = await snapshotDirectory(fixture.root);
    const elsewhereBefore = await snapshotDirectory(fixture.elsewhere);

    const result = await applyIn(fixture.root);
    assert.equal(
      result.changes.find(({ path }) => path === "calavera.config.json")?.type,
      "unchanged",
    );
    assert.equal((await snapshotDirectory(fixture.root))[recipePath], before[recipePath]);
    assert.deepEqual(await snapshotDirectory(fixture.elsewhere), elsewhereBefore);

    // A recipe that differs is written, so the same link stops apply. So does a matching recipe
    // without the earlier apply in the state, because apply then writes the recipe again.
    const written = await readFile(shared);
    await writeFile(shared, "{}\n");
    const differs = await unchanged(fixture, () => refusal(fixture.root, "calavera.config.json"));
    assert.ok(differs.message.includes(`${recipePath} is a link to ${shared}, which is outside`));
    await writeFile(shared, written);
    await rm(join(fixture.root, ".calavera", "state.json"));
    const { message } = await unchanged(fixture, () =>
      refusal(fixture.root, "calavera.config.json"),
    );
    assert.ok(message.includes(`${recipePath} is a link to ${shared}, which is outside`), message);
  },
);

test(
  "apply still writes the recipe through a link to a file inside the project",
  fileLinkSkip,
  async () => {
    await using fixture = await projectAndElsewhere();
    const target = join(fixture.root, "configs", "recipe.json");
    await writeFile(target, "{}\n");
    await symlink(target, join(fixture.root, "calavera.config.json"));

    await applyIn(fixture.root);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")).integrations, recipe.integrations);
  },
);
