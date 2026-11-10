// Issue #880, ADR-0014: when a recipe selects stryker and github-repository-controls, the managed
// .github/dependabot.yml groups @stryker-mutator/*, so Stryker's core and Vitest runner update in
// one pull request. Each case applies to a temporary copy of a committed vp create fixture.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { textHash } from "../src/utils/hash.js";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const DEPENDABOT_PATH = ".github/dependabot.yml";
const controlsOptions = {
  "github-repository-controls": { repository: "example/library", defaultBranch: "main" },
};
const withStryker = buildRecipe(
  "default",
  ["stryker", "github-repository-controls"],
  "pnpm",
  [],
  controlsOptions,
);
const withoutStryker = buildRecipe(
  "default",
  ["github-repository-controls"],
  "pnpm",
  [],
  controlsOptions,
);
const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};
const conflict = /Refusing to overwrite existing managed file: \.github\/dependabot\.yml/;

/**
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const originalDirectory = process.cwd();
  process.chdir(directory);

  try {
    return await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string} root */
async function readDependabot(root) {
  return readFile(`${root}/${DEPENDABOT_PATH}`, "utf8");
}

test("a recipe with stryker and github-repository-controls writes the @stryker-mutator/* group", async () => {
  await using project = await copyReleaseFixture("library");

  await inDirectory(project.root, async () => {
    await applyRecipeObject(withStryker, applyOptions);
  });

  const [npm, actions] = parseYaml(await readDependabot(project.root)).updates;
  assert.equal(npm["package-ecosystem"], "npm");
  assert.deepEqual(npm.groups, { stryker: { patterns: ["@stryker-mutator/*"] } });
  assert.equal("groups" in actions, false);
});

test("a recipe without stryker writes the same dependabot.yml bytes as before the group existed", async () => {
  await using project = await copyReleaseFixture("library");

  await inDirectory(project.root, async () => {
    await applyRecipeObject(withoutStryker, applyOptions);
  });

  const text = await readDependabot(project.root);
  assert.doesNotMatch(text, /groups|stryker/);
  assert.equal(
    text,
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
      include:
        - "*"
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
      include:
        - "*"
`,
  );
});

test("adding stryker to a project whose dependabot.yml Calavera wrote updates the file, and the next dry run reports no drift", async () => {
  await using project = await copyReleaseFixture("library");

  await inDirectory(project.root, async () => {
    await applyRecipeObject(withoutStryker, applyOptions);
    const before = await readDependabot(project.root);

    const dryRun = await applyRecipeObject(withStryker, { ...applyOptions, dryRun: true });
    // The dry run reports a managed file whose planned text differs from the file as a write.
    assert.equal(dryRun.changes.find(({ path }) => path === DEPENDABOT_PATH)?.type, "write");
    assert.equal(await readDependabot(project.root), before, "the dry run wrote the file");

    await applyRecipeObject(withStryker, applyOptions);
    const after = await readDependabot(project.root);
    assert.match(after, /@stryker-mutator\/\*/);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(
      state.managedFiles.find(({ path }) => path === DEPENDABOT_PATH)?.hash,
      textHash(after),
    );

    const secondDryRun = await applyRecipeObject(withStryker, { ...applyOptions, dryRun: true });
    assert.equal(
      secondDryRun.changes.find(({ path }) => path === DEPENDABOT_PATH)?.type,
      "unchanged",
    );
  });
});

test("a local edit to dependabot.yml is a managed-file conflict, with and without stryker", async () => {
  await using project = await copyReleaseFixture("library");

  await inDirectory(project.root, async () => {
    await applyRecipeObject(withStryker, applyOptions);
    const edited = `${await readDependabot(project.root)}# edited by hand\n`;
    await writeFile(DEPENDABOT_PATH, edited);

    await assert.rejects(
      applyRecipeObject(withStryker, { ...applyOptions, dryRun: true }),
      conflict,
    );
    await assert.rejects(applyRecipeObject(withStryker, applyOptions), conflict);
    // Dropping stryker changes the planned bytes again, and the edit still blocks the rewrite.
    await assert.rejects(applyRecipeObject(withoutStryker, applyOptions), conflict);
    assert.equal(await readDependabot(project.root), edited);
  });
});
