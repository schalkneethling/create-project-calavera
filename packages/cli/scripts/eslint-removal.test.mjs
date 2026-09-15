import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, profileDefaults } from "../src/recipe.js";

const removedIds = [
  "eslint",
  "typescript-eslint",
  "eslint-config-prettier",
  "eslint-react",
  "eslint-jsx-a11y",
  "eslint-import",
  "eslint-n",
  "eslint-promise",
  "eslint-unicorn",
  "eslint-sonarjs",
  "eslint-vitest",
  "eslint-jest",
];

test("list_integrations reports no ESLint integration and no ESLint plugin entry", async () => {
  const response = await callMcpTool("list_integrations");
  const ids = response.integrations.map(({ id }) => id);

  for (const removedId of removedIds) {
    assert.equal(
      ids.includes(removedId),
      false,
      `The ${removedId} id is still listed: ${ids.join(", ")}`,
    );
  }

  assert.equal(
    response.integrations.some(({ platform }) => platform === "eslint"),
    false,
  );
  assert.equal(
    response.integrations.some(({ platform }) => platform === "eslint-plugin"),
    false,
  );
  assert.equal(
    response.integrations.some(({ group }) => group === "Classic JS/TS linting"),
    false,
  );
  assert.equal(
    integrationCatalog.some(
      ({ id, platform, group, includes }) =>
        removedIds.includes(id) ||
        platform === "eslint" ||
        platform === "eslint-plugin" ||
        group === "Classic JS/TS linting" ||
        (includes ?? []).some((included) => removedIds.includes(included)),
    ),
    false,
  );
  assert.ok(
    integrationCatalog.some(({ id }) => id === "react-doctor"),
    "The react-doctor entry must survive the removal.",
  );
});

test("list_profiles keeps classic without any ESLint default", async () => {
  const response = await callMcpTool("list_profiles");

  for (const profileId of ["modern", "classic", "minimal"]) {
    const profile = response.profiles.find(({ id }) => id === profileId);

    assert.ok(profile, `The ${profileId} profile must still be listed.`);

    for (const removedId of removedIds) {
      assert.equal(
        profile.defaultIntegrations.includes(removedId),
        false,
        `The ${removedId} id still defaults for ${profileId}: ${profile.defaultIntegrations.join(", ")}`,
      );
      assert.equal(profileDefaults[profileId].includes(removedId), false);
    }
  }
});

test("compose_recipe rejects the eslint id as unknown", async () => {
  await assert.rejects(
    () =>
      callMcpTool("compose_recipe", {
        profile: "classic",
        packageManager: "npm",
        tools: ["eslint"],
      }),
    /eslint/,
  );
});

test("validate_recipe rejects a recipe that requests eslint-react", async () => {
  const recipe = {
    version: 1,
    profile: "classic",
    packageManager: "npm",
    integrations: ["eslint-react"],
    scripts: { quality: true },
  };

  const response = await callMcpTool("validate_recipe", { recipe });

  assert.equal(response.ok, false);
  assert.match(response.error ?? response.message ?? JSON.stringify(response), /eslint-react/);
});

test("a classic profile dry run plans no eslint.config.js and a lint script without eslint", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-eslint-removal-dry-run-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const recipe = buildRecipe("classic", [...profileDefaults.classic], "npm");
    const result = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    assert.equal(
      result.changes.some(({ path }) => path === "eslint.config.js"),
      false,
      `An eslint.config.js change is still planned: ${JSON.stringify(result.changes.map(({ path }) => path))}`,
    );
    assert.equal(
      result.dependencies.some((dependency) => /eslint/.test(dependency)),
      false,
      `ESLint dependencies are still planned: ${result.dependencies.join(", ")}`,
    );

    const packageChange = result.changes.find(
      ({ type, path }) => type === "update" && path === "package.json",
    );
    assert.ok(packageChange, "The dry run must still plan a package.json update.");
    assert.ok(
      (packageChange.scripts ?? []).includes("lint"),
      `A lint script must still be planned: ${JSON.stringify(packageChange.scripts)}`,
    );

    await applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true });

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    assert.doesNotMatch(packageFile.scripts.lint, /eslint/);
    assert.doesNotMatch(packageFile.scripts["lint:fix"], /eslint/);
    assert.doesNotMatch(JSON.stringify(packageFile), /eslint/);

    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(state.files.includes("eslint.config.js"), false);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("inspect_project reports no ESLint finding for an existing eslint.config.js", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-eslint-removal-inspect-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile("eslint.config.js", "export default [];\n");

    const response = await callMcpTool("inspect_project", {
      recipe: buildRecipe("classic", ["editorconfig", "stylelint"], "npm"),
    });

    assert.equal(
      response.files.includes("eslint.config.js"),
      false,
      "Calavera no longer inspects ESLint configuration files.",
    );
    assert.equal(
      response.findings.some(
        ({ kind, path, message }) =>
          /eslint/i.test(kind) || /eslint/i.test(path ?? "") || /eslint/i.test(message ?? ""),
      ),
      false,
      `ESLint-aware findings remain: ${JSON.stringify(response.findings)}`,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});
