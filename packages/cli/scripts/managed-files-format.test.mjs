// Issue #669: in a Vite+ project, `vp check` runs `vp fmt --check`, so every file Calavera writes
// must already be in the shape the project's formatter produces. Calavera formats in memory,
// before the dry run, with the project's own `vp fmt --stdin-filepath`, and never formats a file
// after writing it, because the managed-file comparison relies on the bytes it wrote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { agentBootstrap, applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { copyReleaseFixture, createTemporaryFixture, json } from "./vite-plus-fixtures.mjs";

const recipe = buildRecipe(
  "default",
  ["editorconfig", "stylelint", "html-validate", "knip", "github-repository-controls"],
  "pnpm",
  [],
  { "github-repository-controls": { repository: "example/library" } },
);
const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};
const bootstrapOptions = {
  json: true,
  assumeYes: true,
  mcpHarness: /** @type {const} */ ("claude-code"),
};

/**
 * Runs `callback` with `directory` as the working directory, as the CLI runs.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

/**
 * Runs the project's own `vp fmt` with `args`, as `vp check` does.
 *
 * @param {string} root
 * @param {string[]} args
 */
function vpFmt(root, args) {
  return spawnSync(
    process.execPath,
    [join(root, "node_modules/vite-plus/bin/vp"), "fmt", ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

/**
 * The paths of the files Calavera wrote, from the changes it reported.
 *
 * @param {{ type: string, path?: string }[]} changes
 */
function writtenPaths(changes) {
  return changes
    .filter(({ type, path }) => (type === "write" || type === "update") && path !== undefined)
    .map(({ path }) => /** @type {string} */ (path));
}

/**
 * Applies the recipe and sets up agent guidance in a copy of the `vp create` library fixture.
 *
 * @param {string} root
 */
async function applyAndBootstrap(root) {
  return inDirectory(root, async () => {
    const applied = await applyRecipeObject(recipe, applyOptions);
    const bootstrapped = await agentBootstrap(bootstrapOptions);
    return [...writtenPaths(applied.changes), ...writtenPaths(bootstrapped.changes)];
  });
}

test("Given a new Vite+ project, when Calavera applies a recipe and sets up agent guidance, then vp fmt --check reports nothing", async () => {
  await using project = await copyReleaseFixture("library");
  const written = await applyAndBootstrap(project.root);

  // The seven files #669 found failing, so the check below is known to cover them.
  for (const path of [
    ".github/repository-controls.json",
    ".htmlvalidate.json",
    ".mcp.json",
    ".stylelintrc.json",
    "AGENTS.md",
    "calavera.config.json",
    "docs/repository-controls.md",
  ]) {
    assert.ok(written.includes(path), `Calavera did not write ${path}`);
  }

  const check = vpFmt(project.root, ["--check"]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
});

test("Given guidance appended to an existing AGENTS.md in a Vite+ project, then vp fmt --check reports nothing", async () => {
  await using project = await copyReleaseFixture("library");
  await writeFile(join(project.root, "AGENTS.md"), "# Project guidance\n\nKeep it small.\n");

  await inDirectory(project.root, () =>
    agentBootstrap({ ...bootstrapOptions, agentsMd: "append" }),
  );

  assert.match(await readFile(join(project.root, "AGENTS.md"), "utf8"), /^# Project guidance\n/);
  const check = vpFmt(project.root, ["--check", "AGENTS.md"]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
});

test("Given a Vite+ project, when vp fmt formats it after apply, then nothing changes and a re-apply reports no drift", async () => {
  await using project = await copyReleaseFixture("library");
  // A skill is reported as its directory; its files are compared through the check above.
  const written = [];
  for (const path of await applyAndBootstrap(project.root)) {
    if ((await stat(join(project.root, path))).isFile()) written.push(path);
  }
  const before = await Promise.all(
    written.map((path) => readFile(join(project.root, path), "utf8")),
  );

  const format = vpFmt(project.root, ["--write", "."]);
  assert.equal(format.status, 0, `${format.stdout}${format.stderr}`);
  const after = await Promise.all(
    written.map((path) => readFile(join(project.root, path), "utf8")),
  );
  assert.deepEqual(
    written.filter((_path, index) => before[index] !== after[index]),
    [],
    "vp fmt changed files Calavera wrote",
  );

  await inDirectory(project.root, async () => {
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
    assert.deepEqual(
      dryRun.changes.filter(({ type }) => type !== "unchanged").map(({ path }) => path),
      [],
    );
    assert.deepEqual(
      dryRun.projectInspection.findings.filter(({ severity }) => severity !== "info"),
      [],
    );

    const bootstrap = await agentBootstrap({ ...bootstrapOptions, dryRun: true });
    for (const path of ["AGENTS.md", ".mcp.json"]) {
      assert.deepEqual(
        bootstrap.changes.find((change) => change.path === path),
        { type: "skip", path, reason: "Already up to date." },
        path,
      );
    }
  });
});

test("Given a project Vite+ does not manage, when Calavera applies, then it writes its JSON unformatted", async () => {
  await using project = await createTemporaryFixture("unformatted", {
    "package.json": json({ name: "plain", scripts: {} }),
  });

  await inDirectory(project.root, () => applyRecipeObject(recipe, applyOptions));

  const htmlValidate = await readFile(join(project.root, ".htmlvalidate.json"), "utf8");
  assert.equal(htmlValidate, json(JSON.parse(htmlValidate)));
  assert.match(htmlValidate, /"extends": \[\n/);
});
