import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, profileDefaults } from "../src/recipe.js";

test("list_integrations reports no TypeScript configuration integration", async () => {
  const response = await callMcpTool("list_integrations");
  const ids = response.integrations.map(({ id }) => id);

  assert.equal(
    ids.includes("typescript"),
    false,
    `The typescript id is still listed: ${ids.join(", ")}`,
  );
  assert.equal(
    response.integrations.some(({ platform }) => platform === "typescript"),
    false,
  );
  assert.equal(
    response.integrations.some(({ group }) => group === "Type checking"),
    false,
  );
  assert.equal(
    integrationCatalog.some(
      ({ id, platform, group, includes }) =>
        id === "typescript" ||
        platform === "typescript" ||
        group === "Type checking" ||
        (includes ?? []).includes("typescript"),
    ),
    false,
  );
});

test("list_profiles keeps modern and classic without a TypeScript configuration default", async () => {
  const response = await callMcpTool("list_profiles");

  for (const profileId of ["modern", "classic"]) {
    const profile = response.profiles.find(({ id }) => id === profileId);

    assert.ok(profile, `The ${profileId} profile must still be listed.`);
    assert.equal(
      profile.defaultIntegrations.includes("typescript"),
      false,
      `The typescript id still defaults for ${profileId}: ${profile.defaultIntegrations.join(", ")}`,
    );
    assert.equal(profileDefaults[profileId].includes("typescript"), false);
  }
});

test("compose_recipe rejects the typescript id as unknown", async () => {
  await assert.rejects(
    () =>
      callMcpTool("compose_recipe", {
        profile: "modern",
        packageManager: "npm",
        tools: ["typescript"],
      }),
    /typescript/,
  );
});

test("validate_recipe rejects a recipe that requests typescript", async () => {
  const recipe = {
    version: 1,
    profile: "modern",
    packageManager: "npm",
    integrations: ["typescript"],
    scripts: { quality: true },
  };

  const response = await callMcpTool("validate_recipe", { recipe });

  assert.equal(response.ok, false);
  assert.match(response.error ?? response.message ?? JSON.stringify(response), /typescript/);
});

test("a recipe that still sets scripts.typecheck produces no typecheck script", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-typecheck-flag-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const recipe = {
      ...buildRecipe("classic", ["prettier", "stylelint"], "npm"),
      scripts: { format: true, typecheck: true, quality: true },
    };

    // The recipe schema accepts any boolean-valued script flag, so an obsolete
    // typecheck flag validates and is simply never turned into a script.
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

    assert.equal(
      (packageChange?.scripts ?? []).includes("typecheck"),
      false,
      `A typecheck script is still planned: ${JSON.stringify(packageChange?.scripts)}`,
    );
    assert.equal(
      (packageChange?.omittedScripts ?? []).some(({ script }) => script === "typecheck"),
      false,
      `A typecheck omission is still reported: ${JSON.stringify(packageChange?.omittedScripts)}`,
    );

    await applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true });

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(packageFile.scripts.typecheck, undefined);
    assert.doesNotMatch(JSON.stringify(packageFile.scripts), /tsc --noEmit/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("a modern profile dry run plans no tsconfig.json and no typecheck script", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-typescript-removal-dry-run-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const recipe = buildRecipe("modern", [...profileDefaults.modern], "npm");
    const result = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    assert.equal(
      result.changes.some(({ path }) => path === "tsconfig.json"),
      false,
      `A tsconfig.json change is still planned: ${JSON.stringify(result.changes.map(({ path }) => path))}`,
    );
    assert.equal(
      result.dependencies.some(
        (dependency) => dependency === "typescript" || dependency === "@types/node",
      ),
      false,
      `TypeScript dependencies are still planned: ${result.dependencies.join(", ")}`,
    );

    await applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true });

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    const typecheckScripts = Object.entries(packageFile.scripts ?? {}).filter(
      ([name, command]) => name === "typecheck" || command.includes("tsc "),
    );
    assert.deepEqual(
      typecheckScripts,
      [],
      `Generated scripts still type-check: ${JSON.stringify(typecheckScripts)}`,
    );

    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(state.files.includes("tsconfig.json"), false);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("inspect_project reports no TypeScript finding for an existing tsconfig.json", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-typescript-removal-inspect-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile("tsconfig.json", `${JSON.stringify({ compilerOptions: {} }, null, 2)}\n`);

    const response = await callMcpTool("inspect_project", {
      recipe: buildRecipe("modern", [...profileDefaults.modern], "npm"),
    });

    assert.equal(
      response.findings.some(
        ({ kind, path, message }) =>
          /tsconfig/i.test(kind) ||
          /tsconfig/i.test(path ?? "") ||
          /tsconfig/i.test(message ?? "") ||
          /\btypescript\b/i.test(message ?? ""),
      ),
      false,
      `TypeScript-aware findings remain: ${JSON.stringify(response.findings)}`,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});
