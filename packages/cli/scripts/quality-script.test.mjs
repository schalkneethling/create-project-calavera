// Issue #622 and ADR-0013: in a project Vite+ manages, the generated `quality`
// script runs `vp check` and the Vite+ test step before Calavera's own
// scripts; the Stylelint scripts are `lint:styles` and `lint:styles:fix`; and a
// project applied before the rename has its Calavera-written `lint` and
// `lint:fix` renamed, while a value the user changed is kept and reported.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { createEmptyState, normalizeState } from "../src/state.js";
import { createTemporaryFixture, writeVitePlusFormatter } from "./vite-plus-fixtures.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

const dryRunOptions = { dryRun: true, json: true, noInstall: true, assumeYes: true };
const applyOptions = { json: true, noInstall: true, assumeYes: true };

const stylelintLint = 'stylelint "**/*.{css,scss}" --allow-empty-input';
const stylelintFix = 'stylelint "**/*.{css,scss}" --allow-empty-input --fix';
// The Stylelint command releases before #644 wrote, without --allow-empty-input.
const earlierStylelintLint = 'stylelint "**/*.{css,scss}"';

const managedManifest = (extra = {}) =>
  `${JSON.stringify({ name: "managed", devDependencies: { "vite-plus": "1.0.0" }, ...extra }, null, 2)}\n`;
const unmanagedManifest = `${JSON.stringify({ name: "unmanaged", scripts: {} }, null, 2)}\n`;

/**
 * Runs `callback` with the process working directory set to `directory`, as
 * apply reads the project from `process.cwd()`.
 *
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

/** @param {Array<{ type: string, path: string }>} changes */
function packageChange(changes) {
  return changes.find(({ path }) => path === "package.json");
}

/**
 * The package.json change a dry run plans for `recipe` in a fresh project made
 * of `files`.
 *
 * @param {Record<string, string>} files
 * @param {ReturnType<typeof buildRecipe>} recipe
 */
async function plannedPackageChange(files, recipe) {
  await using fixture = await createTemporaryFixture("quality", files);
  // A managed project formats what apply writes with its own vite-plus (#669).
  await writeVitePlusFormatter(fixture.root);

  return await inDirectory(fixture.root, async () =>
    packageChange((await applyRecipeObject(recipe, dryRunOptions)).changes),
  );
}

/**
 * The scripts apply writes for `integrations` into a fresh project made of
 * `files`.
 *
 * @param {Record<string, string>} files
 * @param {string[]} integrations
 * @param {"npm" | "pnpm" | "yarn" | "bun"} [packageManager]
 */
async function appliedScripts(files, integrations, packageManager = "npm") {
  await using fixture = await createTemporaryFixture("quality", files);
  // A managed project formats what apply writes with its own vite-plus (#669).
  await writeVitePlusFormatter(fixture.root);
  const recipe = buildRecipe("default", integrations, packageManager);

  return await inDirectory(fixture.root, async () => {
    await applyRecipeObject(recipe, applyOptions);
    return JSON.parse(await readFile("package.json", "utf8")).scripts;
  });
}

test("the Stylelint scripts are lint:styles and lint:styles:fix, and apply writes no lint or lint:fix", async () => {
  const scripts = await appliedScripts({ "package.json": unmanagedManifest }, ["stylelint"]);

  assert.equal(scripts["lint:styles"], stylelintLint);
  assert.equal(scripts["lint:styles:fix"], stylelintFix);
  assert.equal(Object.hasOwn(scripts, "lint"), false);
  assert.equal(Object.hasOwn(scripts, "lint:fix"), false);
});

const optionalScripts = [
  { integration: "stylelint", script: "lint:styles" },
  { integration: "html-validate", script: "lint:html" },
  { integration: "knip", script: "knip" },
  { integration: "react-doctor", script: "react:doctor" },
  { integration: "varlock", script: "env:load" },
];
const allIntegrations = optionalScripts.map(({ integration }) => integration);

test("an unmanaged project's quality runs every selected Calavera script and no vp command", async () => {
  const scripts = await appliedScripts({ "package.json": unmanagedManifest }, allIntegrations);

  assert.equal(
    scripts.quality,
    "npm run lint:styles && npm run lint:html && npm run knip && npm run react:doctor && npm run env:load",
  );
  assert.doesNotMatch(scripts.quality, /\bvp\b/);
});

test("a managed project's quality runs vp check and vp test --passWithNoTests, then every selected Calavera script", async () => {
  const scripts = await appliedScripts(
    { "package.json": managedManifest() },
    allIntegrations,
    "pnpm",
  );

  assert.equal(
    scripts.quality,
    "vp check && vp test --passWithNoTests && pnpm lint:styles && pnpm lint:html && pnpm knip && pnpm react:doctor && pnpm env:load",
  );
});

for (const { integration, script } of optionalScripts) {
  test(`quality includes ${script} only when ${integration} is selected`, async () => {
    const without = allIntegrations.filter((id) => id !== integration);

    for (const [files, prefix] of [
      [{ "package.json": unmanagedManifest }, ""],
      [{ "package.json": managedManifest() }, "vp check && vp test --passWithNoTests && "],
    ]) {
      const withScripts = await appliedScripts(files, allIntegrations);
      const withoutScripts = await appliedScripts(files, without);

      assert.ok(withScripts.quality.startsWith(prefix), withScripts.quality);
      assert.ok(withoutScripts.quality.startsWith(prefix), withoutScripts.quality);
      assert.ok(withScripts.quality.includes(`npm run ${script}`), withScripts.quality);
      assert.equal(
        withoutScripts.quality.split(" && ").includes(`npm run ${script}`),
        false,
        withoutScripts.quality,
      );
    }
  });
}

test("a managed project with no Calavera script to aggregate gets no quality script", async () => {
  const change = await plannedPackageChange(
    { "package.json": managedManifest() },
    buildRecipe("minimal", ["editorconfig"], "npm"),
  );

  assert.equal(change.scripts.includes("quality"), false);
  assert.ok(
    change.omittedScripts.some(({ script }) => script === "quality"),
    JSON.stringify(change.omittedScripts),
  );
});

// Issue #230: in a project Vite+ does not manage, a quality script that would
// run one Calavera script is only an alias of that script, so it is not
// generated, and the omission names the script to run instead.
/** @param {string} value */
const singleCheckOmission = (value) =>
  `quality was requested, but it would only run "${value}", so Calavera does not generate quality as an alias of that script.`;

for (const { integration, script } of optionalScripts) {
  test(`an unmanaged project with only ${integration} gets no quality alias of ${script}`, async () => {
    const recipe = buildRecipe("default", [integration], "npm");
    const change = await plannedPackageChange({ "package.json": unmanagedManifest }, recipe);

    assert.equal(change.scripts.includes("quality"), false, JSON.stringify(change.scripts));
    assert.ok(change.scripts.includes(script), JSON.stringify(change.scripts));
    assert.deepEqual(
      change.omittedScripts.find((omission) => omission.script === "quality"),
      { script: "quality", reason: singleCheckOmission(`npm run ${script}`) },
    );

    const scripts = await appliedScripts({ "package.json": unmanagedManifest }, [integration]);
    assert.equal(Object.hasOwn(scripts, "quality"), false);
  });
}

test("an unmanaged project with two checks still gets a quality script that runs both", async () => {
  const scripts = await appliedScripts({ "package.json": unmanagedManifest }, [
    "stylelint",
    "knip",
  ]);

  assert.equal(scripts.quality, "npm run lint:styles && npm run knip");
});

test("a managed project with one check still gets quality, which runs the Vite+ checks first", async () => {
  const scripts = await appliedScripts({ "package.json": managedManifest() }, ["knip"]);

  assert.equal(scripts.quality, "vp check && vp test --passWithNoTests && npm run knip");
});

test("an unmanaged project whose only check left in quality is knip, with lint:html left out, gets no quality alias", async () => {
  const recipe = buildRecipe("default", ["knip", "html-validate"], "npm", [], {
    "html-validate": { quality: false },
  });
  const change = await plannedPackageChange({ "package.json": unmanagedManifest }, recipe);

  assert.equal(change.scripts.includes("quality"), false, JSON.stringify(change.scripts));
  assert.deepEqual(
    change.omittedScripts.find((omission) => omission.script === "quality"),
    { script: "quality", reason: singleCheckOmission("npm run knip") },
  );
});

const knipOnlyRecipe = buildRecipe("default", ["knip"], "npm");

/**
 * Removes the `qualityScript` record from the state file in the working
 * directory, as a release before #230 wrote it.
 */
async function asStateBeforeTheQualityRecord() {
  const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
  delete state.qualityScript;
  await writeFile(".calavera/state.json", `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Applies `recipe` to the fixture at `root`, then sets the package.json
 * scripts in `scripts` and the state file, as a release before #230 left them.
 *
 * @param {string} root
 * @param {ReturnType<typeof buildRecipe>} recipe
 * @param {Record<string, string>} scripts
 */
async function applyAsAnEarlierRelease(root, recipe, scripts) {
  await inDirectory(root, async () => {
    await applyRecipeObject(recipe, applyOptions);
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    packageJSON.scripts = { ...packageJSON.scripts, ...scripts };
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);
    await asStateBeforeTheQualityRecord();
  });
}

const earlierAliasNote =
  " It matches a value an earlier release wrote for this recipe, so remove it if you did not write it yourself.";

test("a state file without the quality record shows nothing, so apply keeps a quality alias and names the match, and a second apply changes nothing", async () => {
  // A release before #230 wrote this state file. It did not write quality when the recipe
  // turned quality off, and the state does not record that flag, so the alias may be the
  // project's own.
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);
  await applyAsAnEarlierRelease(fixture.root, knipOnlyRecipe, { quality: "npm run knip" });

  await inDirectory(fixture.root, async () => {
    const applied = packageChange((await applyRecipeObject(knipOnlyRecipe, applyOptions)).changes);

    assert.equal(applied.removedQualityScript, undefined);
    assert.equal(
      applied.omittedScripts.find(({ script }) => script === "quality")?.reason,
      `${singleCheckOmission("npm run knip")} package.json keeps its quality script, "npm run knip", because Calavera cannot show that it wrote that value.${earlierAliasNote}`,
    );
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts.quality,
      "npm run knip",
    );

    const reapplied = await applyRecipeObject(knipOnlyRecipe, applyOptions);
    assert.ok(
      reapplied.changes.every(({ type }) => type === "unchanged"),
      JSON.stringify(reapplied.changes),
    );
  });
});

test("apply removes an earlier quality value the state records it wrote, once quality would only alias one script", async () => {
  const withHtml = buildRecipe("default", ["html-validate", "knip"], "npm");
  const withoutHtml = buildRecipe("default", ["html-validate", "knip"], "npm", [], {
    "html-validate": { quality: false },
  });
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    await applyRecipeObject(withHtml, applyOptions);
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts.quality,
      "npm run lint:html && npm run knip",
    );

    const applied = packageChange((await applyRecipeObject(withoutHtml, applyOptions)).changes);

    assert.equal(applied.removedQualityScript, "npm run lint:html && npm run knip");
    assert.equal(
      Object.hasOwn(JSON.parse(await readFile("package.json", "utf8")).scripts, "quality"),
      false,
    );
  });
});

test("after an apply before the rename, a quality alias of lint is kept without the quality record, and the dry run names the match", async () => {
  const stylelintRecipe = buildRecipe("default", ["stylelint"], "npm");
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);
  await applyAsBeforeTheRename(fixture.root, stylelintRecipe);

  await inDirectory(fixture.root, async () => {
    // A release before the rename wrote this alias for a Stylelint-only recipe.
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    packageJSON.scripts.quality = "npm run lint";
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);
    await asStateBeforeTheQualityRecord();

    const applied = packageChange((await applyRecipeObject(stylelintRecipe, applyOptions)).changes);
    const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts;

    assert.equal(applied.removedQualityScript, undefined);
    assert.equal(
      applied.omittedScripts.find(({ script }) => script === "quality")?.reason,
      `${singleCheckOmission("npm run lint:styles")} package.json keeps its quality script, "npm run lint", because Calavera cannot show that it wrote that value.${earlierAliasNote}`,
    );
    assert.equal(scripts.quality, "npm run lint");
    assert.equal(scripts["lint:styles"], stylelintLint);
  });
});

test("before any apply, a quality alias of the project's own lint is kept, and the omission says so", async () => {
  const change = await plannedPackageChange(
    {
      "package.json": `${JSON.stringify({ name: "own-lint-alias", scripts: { lint: "eslint .", quality: "npm run lint" } }, null, 2)}\n`,
    },
    buildRecipe("default", ["stylelint"], "npm"),
  );

  assert.equal(change.removedQualityScript, undefined);
  assert.deepEqual(
    change.omittedScripts.find((omission) => omission.script === "quality"),
    {
      script: "quality",
      reason: `${singleCheckOmission("npm run lint:styles")} package.json keeps its quality script, "npm run lint", because Calavera cannot show that it wrote that value.`,
    },
  );
});

test("a quality alias of the project's own lint that the first apply kept is still kept by a second apply", async () => {
  const stylelintRecipe = buildRecipe("default", ["stylelint"], "npm");
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": `${JSON.stringify({ name: "own-lint-alias", scripts: { lint: "eslint .", quality: "npm run lint" } }, null, 2)}\n`,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    const first = packageChange((await applyRecipeObject(stylelintRecipe, applyOptions)).changes);
    assert.equal(first.removedQualityScript, undefined);

    // The first apply wrote .calavera/state.json, but it did not write quality.
    const second = packageChange((await applyRecipeObject(stylelintRecipe, applyOptions)).changes);
    const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts;

    assert.equal(second.removedQualityScript, undefined);
    assert.equal(scripts.quality, "npm run lint");
    assert.equal(scripts.lint, "eslint .");
  });
});

test("a quality alias the user adds after an apply that wrote no quality is kept", async () => {
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    await applyRecipeObject(knipOnlyRecipe, applyOptions);
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    packageJSON.scripts.quality = "npm run knip";
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);

    const reapplied = packageChange(
      (await applyRecipeObject(knipOnlyRecipe, applyOptions)).changes,
    );

    assert.equal(reapplied.removedQualityScript, undefined);
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts.quality,
      "npm run knip",
    );
  });
});

test("apply removes a quality the state records it wrote for another recipe, once the plan omits quality", async () => {
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    await applyRecipeObject(buildRecipe("default", ["stylelint", "knip"], "npm"), applyOptions);
    const applied = packageChange((await applyRecipeObject(knipOnlyRecipe, applyOptions)).changes);

    assert.equal(applied.removedQualityScript, "npm run lint:styles && npm run knip");
    assert.equal(
      Object.hasOwn(JSON.parse(await readFile("package.json", "utf8")).scripts, "quality"),
      false,
    );
  });
});

test("a quality the user edited after apply recorded another value is kept, even when it matches an earlier value", async () => {
  const withHtml = buildRecipe("default", ["html-validate", "knip"], "npm");
  const withoutHtml = buildRecipe("default", ["html-validate", "knip"], "npm", [], {
    "html-validate": { quality: false },
  });
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    // Apply writes and records "npm run lint:html && npm run knip"; the user edits it.
    await applyRecipeObject(withHtml, applyOptions);
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    packageJSON.scripts.quality = "npm run knip";
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);

    const applied = packageChange((await applyRecipeObject(withoutHtml, applyOptions)).changes);

    assert.equal(applied.removedQualityScript, undefined);
    assert.equal(
      applied.omittedScripts.find(({ script }) => script === "quality")?.reason,
      `${singleCheckOmission("npm run knip")} package.json keeps its quality script, "npm run knip", because Calavera cannot show that it wrote that value.`,
    );
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts.quality,
      "npm run knip",
    );
  });
});

test("apply records in the state file the quality value it wrote, or null when it wrote none", async () => {
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    const recordedQuality = async () =>
      JSON.parse(await readFile(".calavera/state.json", "utf8")).qualityScript;

    await applyRecipeObject(buildRecipe("default", ["stylelint", "knip"], "npm"), applyOptions);
    assert.equal(await recordedQuality(), "npm run lint:styles && npm run knip");

    await applyRecipeObject(knipOnlyRecipe, applyOptions);
    assert.equal(await recordedQuality(), null);
  });
});

test("scripts.quality: false keeps the quality and its record, so a later apply that omits quality removes it", async () => {
  // #968: false means "leave the quality script alone", not "forget that Calavera wrote it".
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);
  const recipe = buildRecipe("default", ["stylelint", "knip"], "npm");
  const written = "npm run lint:styles && npm run knip";

  await inDirectory(fixture.root, async () => {
    const recordedQuality = async () =>
      JSON.parse(await readFile(".calavera/state.json", "utf8")).qualityScript;

    await applyRecipeObject(recipe, applyOptions);
    const leftAlone = packageChange(
      (
        await applyRecipeObject(
          { ...recipe, scripts: { ...recipe.scripts, quality: false } },
          applyOptions,
        )
      ).changes,
    );

    assert.equal(leftAlone.removedQualityScript, undefined);
    assert.equal(JSON.parse(await readFile("package.json", "utf8")).scripts.quality, written);
    assert.equal(await recordedQuality(), written);

    const removed = packageChange((await applyRecipeObject(knipOnlyRecipe, applyOptions)).changes);
    assert.equal(removed.removedQualityScript, written);
    assert.equal(await recordedQuality(), null);
  });
});

test("scripts.quality: false records null for a quality the user changed after apply recorded its own", async () => {
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);
  const recipe = buildRecipe("default", ["stylelint", "knip"], "npm");

  await inDirectory(fixture.root, async () => {
    await applyRecipeObject(recipe, applyOptions);
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    packageJSON.scripts.quality = "npm run knip";
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);

    await applyRecipeObject(
      { ...recipe, scripts: { ...recipe.scripts, quality: false } },
      applyOptions,
    );

    assert.equal(JSON.parse(await readFile(".calavera/state.json", "utf8")).qualityScript, null);
    const kept = packageChange((await applyRecipeObject(knipOnlyRecipe, applyOptions)).changes);
    assert.equal(kept.removedQualityScript, undefined);
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts.quality,
      "npm run knip",
    );
  });
});

test("clean keeps the quality record in the state file it rewrites", async () => {
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    // The recipe drops editorconfig, so clean has a stale managed file to remove and
    // rewrites the state file.
    await applyRecipeObject(
      buildRecipe("default", ["editorconfig", "stylelint", "knip"], "npm"),
      applyOptions,
    );
    await applyRecipeObject(buildRecipe("default", ["stylelint", "knip"], "npm"), applyOptions);
    const before = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.ok(before.files.includes(".editorconfig"), JSON.stringify(before.files));

    await execFileAsync(process.execPath, [cliPath, "clean", "--yes", "--json"]);

    const after = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(after.files.includes(".editorconfig"), false, JSON.stringify(after.files));
    assert.equal(after.qualityScript, "npm run lint:styles && npm run knip");
  });
});

test("the state file's qualityScript is a string or null, and a state file without it keeps it absent", () => {
  assert.equal(Object.hasOwn(normalizeState({}), "qualityScript"), false);
  assert.equal(normalizeState({ qualityScript: null }).qualityScript, null);
  assert.equal(normalizeState({ qualityScript: "npm run knip" }).qualityScript, "npm run knip");
  assert.equal(createEmptyState().qualityScript, null);
  assert.throws(
    () => normalizeState({ qualityScript: 1 }),
    /Calavera state qualityScript must be a string or null\./,
  );
});

test("a managed project applied before the rename, with one check, still warns that the user's lint left quality", async () => {
  const stylelintRecipe = buildRecipe("default", ["stylelint"], "npm");
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": managedManifest(),
  });
  await writeVitePlusFormatter(fixture.root);
  await applyAsBeforeTheRename(fixture.root, stylelintRecipe, { lint: "stylelint src" });

  await inDirectory(fixture.root, async () => {
    const dryRun = await applyRecipeObject(stylelintRecipe, dryRunOptions);
    const [finding] = dryRun.projectInspection.findings.filter(
      ({ kind }) => kind === "legacy-package-script",
    );

    assert.match(
      finding.message,
      /The generated quality script now runs "lint:styles" instead of "lint", so your "lint" no longer runs as part of quality\.$/,
    );
  });
});

test("a blocked rename does not promise a quality script that a single check does not get", async () => {
  const stylelintRecipe = buildRecipe("default", ["stylelint"], "npm");
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": unmanagedManifest,
  });
  await writeVitePlusFormatter(fixture.root);
  await applyAsBeforeTheRename(fixture.root, stylelintRecipe, { "lint:styles": "stylelint src" });

  await inDirectory(fixture.root, async () => {
    const dryRun = await applyRecipeObject(stylelintRecipe, dryRunOptions);
    const change = packageChange(dryRun.changes);
    const [finding] = dryRun.projectInspection.findings.filter(
      ({ kind }) => kind === "legacy-package-script-conflict",
    );

    assert.equal(change.scripts.includes("quality"), false, JSON.stringify(change.scripts));
    assert.equal(
      change.omittedScripts.find(({ script }) => script === "lint:styles")?.reason,
      "package.json defines lint:styles with a value of your own, and lint still has the value Calavera wrote, so Calavera keeps both instead of renaming lint.",
    );
    assert.doesNotMatch(finding.message, /quality/);
  });
});

test("apply keeps a quality of the user's own when quality would be an alias, and says so", async () => {
  const userQuality = "npm run knip && npm test";
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": `${JSON.stringify({ name: "user-quality", scripts: { quality: userQuality } }, null, 2)}\n`,
  });
  await writeVitePlusFormatter(fixture.root);

  await inDirectory(fixture.root, async () => {
    const applied = packageChange((await applyRecipeObject(knipOnlyRecipe, applyOptions)).changes);

    assert.equal(applied.removedQualityScript, undefined);
    assert.deepEqual(
      applied.omittedScripts.find((omission) => omission.script === "quality"),
      {
        script: "quality",
        reason: `${singleCheckOmission("npm run knip")} package.json keeps its quality script, "${userQuality}", because Calavera cannot show that it wrote that value.`,
      },
    );
    assert.equal(JSON.parse(await readFile("package.json", "utf8")).scripts.quality, userQuality);
  });
});

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const memberWithTest = json({ name: "member", scripts: { test: "vp test" } });
const memberWithoutTest = json({ name: "member" });

// ADR-0013, Decision 4: each package manager reads its own workspace
// definition, and the test step needs a package that defines test.
const workspaceRoots = [
  {
    name: "a pnpm workspace root, whose pnpm-workspace.yaml lists packages",
    packageManager: "pnpm",
    files: {
      "package.json": managedManifest(),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/member/package.json": memberWithTest,
    },
    quality: "vp check && vp run -r test && pnpm lint:styles",
  },
  {
    name: "an npm workspace root, whose package.json lists workspaces",
    packageManager: "npm",
    files: {
      "package.json": managedManifest({ workspaces: ["packages/*"] }),
      "packages/member/package.json": memberWithTest,
    },
    quality: "vp check && vp run -r test && npm run lint:styles",
  },
  {
    name: "a Yarn workspace root, whose package.json lists workspaces.packages",
    packageManager: "yarn",
    files: {
      "package.json": managedManifest({ workspaces: { packages: ["packages/*"] } }),
      "packages/member/package.json": memberWithTest,
    },
    quality: "vp check && vp run -r test && yarn lint:styles",
  },
  {
    name: "a Bun workspace root, whose package.json lists workspaces",
    packageManager: "bun",
    files: {
      "package.json": managedManifest({ workspaces: ["./packages/*/"] }),
      "packages/member/package.json": memberWithTest,
    },
    quality: "vp check && vp run -r test && bun run lint:styles",
  },
  {
    name: "a workspace root whose own package.json defines test while no member does",
    packageManager: "npm",
    files: {
      "package.json": managedManifest({
        workspaces: ["packages/*"],
        scripts: { test: "vp test --passWithNoTests" },
      }),
      "packages/member/package.json": memberWithoutTest,
    },
    quality: "vp check && vp run -r test && npm run lint:styles",
  },
];

for (const { name, packageManager, files, quality } of workspaceRoots) {
  test(`at ${name}, quality runs every package's test script with vp run -r test`, async () => {
    const scripts = await appliedScripts(files, ["stylelint"], packageManager);

    assert.equal(scripts.quality, quality);
  });
}

// A workspace in which no package defines test would fail vp run -r test
// with Task "test" not found, so the step is left out and the dry run says so.
const workspacesWithoutTest = [
  {
    name: "no package defines test",
    files: {
      "package.json": managedManifest({ workspaces: ["packages/*"] }),
      "packages/member/package.json": memberWithoutTest,
    },
  },
  {
    name: "the only member that defines test is excluded",
    files: {
      "package.json": managedManifest({ workspaces: ["packages/*", "!packages/legacy"] }),
      "packages/member/package.json": memberWithoutTest,
      "packages/legacy/package.json": memberWithTest,
    },
  },
  {
    name: "the only package that defines test is under node_modules",
    files: {
      "package.json": managedManifest({ workspaces: ["packages/**"] }),
      "packages/member/package.json": memberWithoutTest,
      "packages/member/node_modules/dependency/package.json": memberWithTest,
    },
  },
];

for (const { name, files } of workspacesWithoutTest) {
  test(`at a workspace root where ${name}, quality leaves out vp run -r test and the dry run says why`, async () => {
    const recipe = buildRecipe("default", ["stylelint"], "npm");
    const change = await plannedPackageChange(files, recipe);

    assert.deepEqual(change.omittedScripts, []);
    assert.deepEqual(change.omittedQualitySteps, [
      {
        step: "vp run -r test",
        reason:
          'neither the workspace root nor any workspace member defines a test script, so vp run -r test would fail with Task "test" not found.',
      },
    ]);
    assert.equal(
      (await appliedScripts(files, ["stylelint"])).quality,
      "vp check && npm run lint:styles",
    );
  });
}

test("the CLI dry run names the vp run -r test step it leaves out of quality", async () => {
  await using fixture = await createTemporaryFixture("quality-no-test", {
    ...workspacesWithoutTest[0].files,
    "calavera.config.json": json(buildRecipe("default", ["stylelint"], "npm")),
  });
  await writeVitePlusFormatter(fixture.root);
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "apply", "--dry-run"], {
    cwd: fixture.root,
  });

  assert.match(
    stdout,
    /Would omit vp run -r test from script quality: neither the workspace root nor any workspace member defines a test script/,
  );
});

// Not a workspace root for the package manager in use: the project runs
// vp test --passWithNoTests itself.
const notWorkspaceRoots = [
  {
    name: "a pnpm-workspace.yaml that only holds catalogs, as in vp create vite:library",
    packageManager: "pnpm",
    files: {
      "package.json": managedManifest(),
      "pnpm-workspace.yaml": "catalog:\n  vite-plus: 1.0.0\n",
    },
  },
  {
    name: "a pnpm-workspace.yaml whose packages list is empty",
    packageManager: "pnpm",
    files: { "package.json": managedManifest(), "pnpm-workspace.yaml": "packages: []\n" },
  },
  {
    name: "an unparseable pnpm-workspace.yaml",
    packageManager: "pnpm",
    files: { "package.json": managedManifest(), "pnpm-workspace.yaml": "packages: [\n" },
  },
  {
    name: "a pnpm project whose workspaces are only in package.json, which pnpm does not read",
    packageManager: "pnpm",
    files: {
      "package.json": managedManifest({ workspaces: ["packages/*"] }),
      "packages/member/package.json": memberWithTest,
    },
  },
  {
    name: "an npm project whose workspaces are only in pnpm-workspace.yaml, which npm does not read",
    packageManager: "npm",
    files: {
      "package.json": managedManifest(),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/member/package.json": memberWithTest,
    },
  },
  {
    name: "an empty workspaces array",
    packageManager: "npm",
    files: { "package.json": managedManifest({ workspaces: [] }) },
  },
  {
    name: "an empty workspaces.packages array",
    packageManager: "yarn",
    files: { "package.json": managedManifest({ workspaces: { packages: [] } }) },
  },
];

for (const { name, packageManager, files } of notWorkspaceRoots) {
  test(`${name} is not a workspace root, so quality runs vp test --passWithNoTests`, async () => {
    const scripts = await appliedScripts(files, ["stylelint"], packageManager);
    const run = { npm: "npm run", pnpm: "pnpm", yarn: "yarn", bun: "bun run" }[packageManager];

    assert.equal(scripts.quality, `vp check && vp test --passWithNoTests && ${run} lint:styles`);
  });
}

test("a workspace member with a manifest of its own runs vp test --passWithNoTests in the member", async () => {
  await using fixture = await createTemporaryFixture("quality-member", {
    "package.json": managedManifest({ workspaces: ["packages/*"] }),
    "packages/member/package.json": `${JSON.stringify({ name: "member" }, null, 2)}\n`,
  });
  await writeVitePlusFormatter(fixture.root);
  const scripts = await inDirectory(join(fixture.root, "packages/member"), async () => {
    await applyRecipeObject(buildRecipe("default", ["stylelint"], "npm"), applyOptions);
    return JSON.parse(await readFile("package.json", "utf8")).scripts;
  });

  assert.equal(scripts.quality, "vp check && vp test --passWithNoTests && npm run lint:styles");
});

/**
 * Applies `recipe` to a fresh project, then rewrites its scripts as Calavera
 * wrote them before the rename: the Stylelint scripts under `lint` and
 * `lint:fix`, and `quality` running `lint`.
 *
 * @param {string} root
 * @param {ReturnType<typeof buildRecipe>} recipe
 * @param {{ lint?: string, "lint:fix"?: string, "lint:styles"?: string }} [legacy]
 */
async function applyAsBeforeTheRename(root, recipe, legacy = {}) {
  await inDirectory(root, async () => {
    // The CLI dry run reads the recipe from calavera.config.json.
    await applyRecipeObject(recipe, {
      ...applyOptions,
      writeConfig: true,
      config: "calavera.config.json",
    });
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    const { "lint:styles": lint, "lint:styles:fix": lintFix, ...rest } = packageJSON.scripts;
    packageJSON.scripts = {
      lint: legacy.lint ?? lint,
      "lint:fix": legacy["lint:fix"] ?? lintFix,
      ...rest,
      ...(legacy["lint:styles"] ? { "lint:styles": legacy["lint:styles"] } : {}),
      quality: "npm run lint && npm run knip",
    };
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);
  });
}

const renameRecipe = buildRecipe("default", ["stylelint", "knip"], "npm");

test("a project applied before the rename: the dry run shows lint and lint:fix renamed, and apply renames them", async () => {
  await using fixture = await createTemporaryFixture("quality-rename", {
    "package.json": unmanagedManifest,
  });
  await applyAsBeforeTheRename(fixture.root, renameRecipe);

  await inDirectory(fixture.root, async () => {
    const dryRun = await applyRecipeObject(renameRecipe, dryRunOptions);
    const change = packageChange(dryRun.changes);

    assert.equal(change.type, "update");
    assert.deepEqual(change.renamedScripts, [
      { from: "lint", to: "lint:styles" },
      { from: "lint:fix", to: "lint:styles:fix" },
    ]);
    assert.deepEqual(
      dryRun.projectInspection.findings.filter(({ kind }) => kind.endsWith("-package-script")),
      [],
    );

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "apply", "--dry-run"]);
    assert.match(stdout, /Would rename script lint to lint:styles/);
    assert.match(stdout, /Would rename script lint:fix to lint:styles:fix/);
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts.lint,
      stylelintLint,
      "the dry run changed package.json",
    );

    await applyRecipeObject(renameRecipe, applyOptions);
    const { scripts } = JSON.parse(await readFile("package.json", "utf8"));

    assert.equal(Object.hasOwn(scripts, "lint"), false);
    assert.equal(Object.hasOwn(scripts, "lint:fix"), false);
    assert.equal(scripts["lint:styles"], stylelintLint);
    assert.equal(scripts["lint:styles:fix"], stylelintFix);
    assert.equal(scripts.quality, "npm run lint:styles && npm run knip");
    // Each renamed script keeps the position the old name had.
    assert.deepEqual(Object.keys(scripts).slice(0, 2), ["lint:styles", "lint:styles:fix"]);

    const secondDryRun = await applyRecipeObject(renameRecipe, dryRunOptions);
    assert.equal(packageChange(secondDryRun.changes).type, "unchanged");
    assert.equal(packageChange(secondDryRun.changes).renamedScripts, undefined);
  });
});

test("a project applied before the rename whose lint the user changed keeps it and warns that it left quality", async () => {
  await using fixture = await createTemporaryFixture("quality-rename-edited", {
    "package.json": unmanagedManifest,
  });
  await applyAsBeforeTheRename(fixture.root, renameRecipe, { lint: "stylelint src" });

  await inDirectory(fixture.root, async () => {
    const dryRun = await applyRecipeObject(renameRecipe, dryRunOptions);
    const change = packageChange(dryRun.changes);

    assert.deepEqual(change.renamedScripts, [{ from: "lint:fix", to: "lint:styles:fix" }]);
    assert.deepEqual(
      dryRun.projectInspection.findings
        .filter(({ kind }) => kind === "legacy-package-script")
        .map(({ severity, path, message }) => ({ severity, path, message })),
      [
        {
          severity: "warning",
          path: "package.json",
          message:
            'package.json defines "lint", the name Calavera used for this recipe\'s Stylelint script before it became "lint:styles". Its value matches no value Calavera wrote for "lint", so Calavera keeps "lint" as your own script and writes "lint:styles" beside it. The generated quality script now runs "lint:styles" instead of "lint", so your "lint" no longer runs as part of quality.',
        },
      ],
    );

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "apply", "--dry-run"]);
    assert.doesNotMatch(stdout, /Would rename script lint to/);
    assert.match(stdout, /Inspection warning: package\.json defines "lint"/);

    await applyRecipeObject(renameRecipe, applyOptions);
    const { scripts } = JSON.parse(await readFile("package.json", "utf8"));

    assert.equal(scripts.lint, "stylelint src");
    assert.equal(Object.hasOwn(scripts, "lint:fix"), false);
    assert.equal(scripts["lint:styles"], stylelintLint);
    assert.equal(scripts["lint:styles:fix"], stylelintFix);
  });
});

test("a lint script in a project Calavera never applied to is not renamed or reported", async () => {
  await using fixture = await createTemporaryFixture("quality-rename-foreign", {
    "package.json": `${JSON.stringify({ scripts: { lint: earlierStylelintLint } }, null, 2)}\n`,
  });

  await inDirectory(fixture.root, async () => {
    const dryRun = await applyRecipeObject(renameRecipe, dryRunOptions);

    assert.equal(packageChange(dryRun.changes).renamedScripts, undefined);
    assert.deepEqual(
      dryRun.projectInspection.findings.filter(({ kind }) => kind === "legacy-package-script"),
      [],
    );

    await applyRecipeObject(renameRecipe, applyOptions);
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts.lint,
      earlierStylelintLint,
    );
  });
});

test("a lint and lint:fix an earlier release wrote, with Oxlint, ESLint, or the run-if-files helper, are renamed", async () => {
  // 2.1.0 to 2.6.0 wrote the parts bare; 1.0.1 to 2.0.6 wrapped each one in
  // run-if-files (ADR-0013, Decision 6).
  await using fixture = await createTemporaryFixture("quality-rename-historical", {
    "package.json": unmanagedManifest,
  });
  await applyAsBeforeTheRename(fixture.root, renameRecipe, {
    lint: `oxlint . && eslint . && ${earlierStylelintLint}`,
    "lint:fix":
      'node .calavera/run-if-files.mjs "JavaScript/TypeScript" "js,jsx,ts,tsx,mjs,cjs" -- oxlint --fix . && node .calavera/run-if-files.mjs "CSS" "css,scss" -- stylelint "**/*.{css,scss}" --fix',
  });

  await inDirectory(fixture.root, async () => {
    const dryRun = await applyRecipeObject(renameRecipe, dryRunOptions);

    assert.deepEqual(packageChange(dryRun.changes).renamedScripts, [
      { from: "lint", to: "lint:styles" },
      { from: "lint:fix", to: "lint:styles:fix" },
    ]);
    assert.deepEqual(
      dryRun.projectInspection.findings.filter(({ kind }) => kind.startsWith("legacy-")),
      [],
    );

    await applyRecipeObject(renameRecipe, applyOptions);
    const { scripts } = JSON.parse(await readFile("package.json", "utf8"));

    assert.equal(Object.hasOwn(scripts, "lint"), false);
    assert.equal(Object.hasOwn(scripts, "lint:fix"), false);
    assert.equal(scripts["lint:styles"], stylelintLint);
    assert.equal(scripts["lint:styles:fix"], stylelintFix);
  });
});

test("a rename that would overwrite the user's own lint:styles does not happen, and both scripts are kept and reported", async () => {
  await using fixture = await createTemporaryFixture("quality-rename-blocked", {
    "package.json": unmanagedManifest,
  });
  await applyAsBeforeTheRename(fixture.root, renameRecipe, { "lint:styles": "stylelint src" });

  await inDirectory(fixture.root, async () => {
    const dryRun = await applyRecipeObject(renameRecipe, dryRunOptions);
    const change = packageChange(dryRun.changes);
    const findings = dryRun.projectInspection.findings;

    assert.deepEqual(change.renamedScripts, [{ from: "lint:fix", to: "lint:styles:fix" }]);
    assert.equal(change.scripts.includes("lint:styles"), false);
    assert.deepEqual(
      change.omittedScripts.filter(({ script }) => script === "lint:styles"),
      [
        {
          script: "lint:styles",
          reason:
            "package.json defines lint:styles with a value of your own, and lint still has the value Calavera wrote, so Calavera keeps both instead of renaming lint; the generated quality script runs your lint:styles.",
        },
      ],
    );
    assert.deepEqual(
      findings
        .filter(({ kind }) => kind === "legacy-package-script-conflict")
        .map(({ severity, message }) => ({ severity, message })),
      [
        {
          severity: "warning",
          message:
            'package.json defines "lint" with a value Calavera wrote, and "lint:styles" with a value of your own. Calavera does not rename "lint" to "lint:styles", because that would overwrite your "lint:styles"; it keeps both scripts as they are. Until then, the generated quality script runs your "lint:styles". Rename or remove your "lint:styles" and apply again to complete the rename.',
        },
      ],
    );
    assert.equal(
      findings.some(
        ({ kind, message }) =>
          kind === "existing-package-script" && message.includes('"lint:styles"'),
      ),
      false,
    );

    await applyRecipeObject(renameRecipe, applyOptions);
    const { scripts } = JSON.parse(await readFile("package.json", "utf8"));

    assert.equal(scripts.lint, stylelintLint);
    assert.equal(scripts["lint:styles"], "stylelint src");
    assert.equal(scripts.quality, "npm run lint:styles && npm run knip");
    assert.equal(scripts["lint:styles:fix"], stylelintFix);
  });
});

for (const lint of ["eslint .", "oxlint . && eslint ."]) {
  test(`a lint of "${lint}", without the Stylelint part, is kept with a warning, not renamed`, async () => {
    await using fixture = await createTemporaryFixture("quality-rename-no-stylelint", {
      "package.json": unmanagedManifest,
    });
    await applyAsBeforeTheRename(fixture.root, renameRecipe, { lint });

    await inDirectory(fixture.root, async () => {
      const dryRun = await applyRecipeObject(renameRecipe, dryRunOptions);

      assert.deepEqual(packageChange(dryRun.changes).renamedScripts, [
        { from: "lint:fix", to: "lint:styles:fix" },
      ]);
      assert.deepEqual(
        dryRun.projectInspection.findings
          .filter(({ kind }) => kind === "legacy-package-script")
          .map(({ severity }) => severity),
        ["warning"],
      );

      await applyRecipeObject(renameRecipe, applyOptions);
      const { scripts } = JSON.parse(await readFile("package.json", "utf8"));

      assert.equal(scripts.lint, lint);
      assert.equal(scripts["lint:styles"], stylelintLint);
    });
  });
}

// #937: in a managed project, the quality a release before #644 wrote when
// lint:html was the only Calavera script, with the Vite+ steps, is kept like
// any value the state does not record, and named when the state predates the record.
const htmlOnlyQualityOff = buildRecipe("minimal", ["html-validate"], "npm", [], {
  "html-validate": { quality: false },
});
const managedHtmlQuality = "vp check && vp test --passWithNoTests && npm run lint:html";
const htmlOnlyKeptReason = `quality was requested, but integrationOptions["html-validate"].quality leaves out lint:html, the only generated script quality would run, so Calavera does not generate quality. package.json keeps its quality script, "${managedHtmlQuality}", because Calavera cannot show that it wrote that value.`;

/** @param {{ omittedScripts?: Array<{ script: string, reason: string }> }} change */
function qualityOmissionReason(change) {
  return change.omittedScripts?.find(({ script }) => script === "quality")?.reason;
}

test("a first apply to a managed project keeps its own quality with the Vite+ steps and lint:html, and says so", async () => {
  const change = await plannedPackageChange(
    { "package.json": managedManifest({ scripts: { quality: managedHtmlQuality } }) },
    htmlOnlyQualityOff,
  );

  assert.equal(change.removedQualityScript, undefined);
  assert.equal(qualityOmissionReason(change), htmlOnlyKeptReason);
});

test("a managed project whose state predates the quality record keeps the Vite+ lint:html quality and names the match", async () => {
  await using fixture = await createTemporaryFixture("quality", {
    "package.json": managedManifest(),
  });
  await writeVitePlusFormatter(fixture.root);
  await applyAsAnEarlierRelease(fixture.root, htmlOnlyQualityOff, { quality: managedHtmlQuality });

  const change = await inDirectory(fixture.root, async () =>
    packageChange((await applyRecipeObject(htmlOnlyQualityOff, dryRunOptions)).changes),
  );

  assert.equal(change.removedQualityScript, undefined);
  assert.equal(qualityOmissionReason(change), `${htmlOnlyKeptReason}${earlierAliasNote}`);
});
