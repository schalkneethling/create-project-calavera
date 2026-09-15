import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, profileDefaults } from "../src/recipe.js";

const removedIds = ["prettier", "prettier-tailwind", "prettier-svelte", "prettier-astro"];

test("list_integrations reports no Prettier integration and no Prettier plugin entry", async () => {
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
    response.integrations.some(({ platform }) => platform === "prettier"),
    false,
  );
  assert.equal(
    response.integrations.some(({ platform }) => platform === "prettier-plugin"),
    false,
  );
  assert.equal(
    response.integrations.some(({ group }) => group === "Formatting"),
    false,
  );
  assert.equal(
    integrationCatalog.some(
      ({ id, platform, group, includes }) =>
        removedIds.includes(id) ||
        platform === "prettier" ||
        platform === "prettier-plugin" ||
        group === "Formatting" ||
        (includes ?? []).some((included) => removedIds.includes(included)),
    ),
    false,
  );
  assert.equal(
    integrationCatalog.some(({ dependencies }) =>
      (dependencies ?? []).some((dependency) => dependency.startsWith("prettier")),
    ),
    false,
    "No catalog entry may install a Prettier package.",
  );
  assert.ok(
    integrationCatalog.some(({ id }) => id === "react-doctor"),
    "The react-doctor entry must survive the removal.",
  );
});

test("list_profiles keeps classic without any Prettier default", async () => {
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

test("compose_recipe rejects the prettier id as unknown", async () => {
  await assert.rejects(
    () =>
      callMcpTool("compose_recipe", {
        profile: "classic",
        packageManager: "npm",
        tools: ["prettier"],
      }),
    /prettier/,
  );
});

test("validate_recipe rejects a recipe that requests prettier-tailwind", async () => {
  const recipe = {
    version: 1,
    profile: "classic",
    packageManager: "npm",
    integrations: ["prettier-tailwind"],
    scripts: { quality: true },
  };

  const response = await callMcpTool("validate_recipe", { recipe });

  assert.equal(response.ok, false);
  assert.match(response.error ?? response.message ?? JSON.stringify(response), /prettier-tailwind/);
});

test("a classic profile dry run plans no Prettier configuration and no format scripts", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-prettier-removal-dry-run-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const recipe = buildRecipe("classic", [...profileDefaults.classic], "npm");
    const result = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    for (const path of [".prettierrc.json", ".prettierignore"]) {
      assert.equal(
        result.changes.some((change) => change.path === path),
        false,
        `A ${path} change is still planned: ${JSON.stringify(result.changes.map(({ path: changed }) => changed))}`,
      );
    }

    assert.equal(
      result.dependencies.some((dependency) => /prettier/.test(dependency)),
      false,
      `Prettier dependencies are still planned: ${result.dependencies.join(", ")}`,
    );

    const packageChange = result.changes.find(
      ({ type, path }) => type === "update" && path === "package.json",
    );
    assert.ok(packageChange, "The dry run must still plan a package.json update.");

    for (const script of ["format", "format:check"]) {
      assert.equal(
        (packageChange.scripts ?? []).includes(script),
        false,
        `A ${script} script is still planned: ${JSON.stringify(packageChange.scripts)}`,
      );
    }

    await applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true });

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(Object.hasOwn(packageFile.scripts, "format"), false);
    assert.equal(Object.hasOwn(packageFile.scripts, "format:check"), false);
    assert.doesNotMatch(JSON.stringify(packageFile), /prettier/);
    assert.doesNotMatch(packageFile.scripts.quality ?? "", /format/);

    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(state.files.includes(".prettierrc.json"), false);
    assert.equal(state.files.includes(".prettierignore"), false);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("inspect_project reports no Prettier finding for an existing .prettierrc.json", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-prettier-removal-inspect-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile(".prettierrc.json", "{}\n");
    await writeFile(".prettierignore", "node_modules\n");

    const response = await callMcpTool("inspect_project", {
      recipe: buildRecipe("classic", ["editorconfig", "stylelint"], "npm"),
    });

    assert.equal(
      response.files.includes(".prettierrc.json"),
      false,
      "Calavera no longer inspects Prettier configuration files.",
    );
    assert.equal(
      response.files.includes(".prettierignore"),
      false,
      "Calavera no longer inspects Prettier ignore files.",
    );
    assert.equal(
      response.findings.some(
        ({ kind, path, message }) =>
          /prettier/i.test(kind) || /prettier/i.test(path ?? "") || /prettier/i.test(message ?? ""),
      ),
      false,
      `Prettier-aware findings remain: ${JSON.stringify(response.findings)}`,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("a recipe that still sets scripts.format produces no format script", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-format-flag-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const recipe = {
      ...buildRecipe("classic", ["editorconfig", "stylelint"], "npm"),
      scripts: { lint: true, format: true, "format:check": true, quality: true },
    };

    // The recipe schema accepts any boolean-valued script flag, so obsolete
    // format flags validate and are simply never turned into scripts.
    const validation = await callMcpTool("validate_recipe", { recipe });
    assert.equal(validation.ok, true);

    const result = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });
    const packageChange = result.changes.find(
      ({ type, path }) => type === "update" && path === "package.json",
    );

    for (const script of ["format", "format:check"]) {
      assert.equal(
        (packageChange?.scripts ?? []).includes(script),
        false,
        `A ${script} script is still planned: ${JSON.stringify(packageChange?.scripts)}`,
      );
      assert.equal(
        (packageChange?.omittedScripts ?? []).some(({ script: omitted }) => omitted === script),
        false,
        `A ${script} omission is still reported: ${JSON.stringify(packageChange?.omittedScripts)}`,
      );
    }

    await applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true });

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(packageFile.scripts.format, undefined);
    assert.equal(packageFile.scripts["format:check"], undefined);
    assert.doesNotMatch(JSON.stringify(packageFile.scripts), /format/);
  } finally {
    process.chdir(originalDirectory);
  }
});
