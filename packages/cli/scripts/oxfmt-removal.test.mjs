import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, catalogResponse, composeRecipe, profileDefaults } from "../src/recipe.js";
import { isOxfmtId } from "./removed-toolchain-ids.mjs";

function hasOxfmtId(ids) {
  return ids.some(isOxfmtId);
}

test("list_integrations reports no Oxfmt integration and no Oxfmt platform", async () => {
  const response = await callMcpTool("list_integrations");
  const ids = response.integrations.map(({ id }) => id);

  assert.equal(hasOxfmtId(ids), false, `Oxfmt ids still listed: ${ids.join(", ")}`);
  assert.equal(
    response.integrations.some(({ platform }) => platform === "oxfmt"),
    false,
  );
  assert.equal(
    integrationCatalog.some(
      ({ id, platform, dependencies, includes }) =>
        isOxfmtId(id) ||
        platform === "oxfmt" ||
        (dependencies ?? []).includes("oxfmt") ||
        (includes ?? []).includes("oxfmt"),
    ),
    false,
  );
});

test("list_profiles keeps the default profile without any Oxfmt default", async () => {
  const response = await callMcpTool("list_profiles");
  const defaultProfile = response.profiles.find(({ id }) => id === "default");

  assert.ok(defaultProfile, "The default profile must still be listed.");
  assert.equal(
    hasOxfmtId(defaultProfile.defaultIntegrations),
    false,
    `Oxfmt ids still default for the default profile: ${defaultProfile.defaultIntegrations.join(", ")}`,
  );
  assert.equal(hasOxfmtId(profileDefaults.default), false);
  assert.doesNotMatch(
    defaultProfile.description,
    /format/i,
    `The default profile description must not claim formatting: ${defaultProfile.description}`,
  );
  assert.doesNotMatch(
    defaultProfile.description,
    /JavaScript.*lint|TypeScript.*lint/i,
    `The default profile description must not claim JavaScript or TypeScript linting: ${defaultProfile.description}`,
  );
});

test("catalogResponse keeps the default profile description free of formatting and JS/TS linting claims", () => {
  const response = catalogResponse(composeRecipe({ profile: "default" }));
  const defaultProfile = response.profiles.find(({ id }) => id === "default");

  assert.ok(defaultProfile, "The default profile must still be listed in catalogResponse.");
  assert.doesNotMatch(
    defaultProfile.description,
    /format/i,
    `The default profile description must not claim formatting: ${defaultProfile.description}`,
  );
  assert.doesNotMatch(
    defaultProfile.description,
    /JavaScript.*lint|TypeScript.*lint/i,
    `The default profile description must not claim JavaScript or TypeScript linting: ${defaultProfile.description}`,
  );
});

test("compose_recipe rejects the oxfmt id as unknown", async () => {
  await assert.rejects(
    () =>
      callMcpTool("compose_recipe", {
        profile: "default",
        packageManager: "npm",
        tools: ["oxfmt"],
      }),
    /oxfmt/,
  );
});

test("validate_recipe rejects a recipe that requests oxfmt", async () => {
  const recipe = {
    version: 1,
    profile: "default",
    packageManager: "npm",
    integrations: ["oxfmt"],
    scripts: { format: true },
  };

  const response = await callMcpTool("validate_recipe", { recipe });

  assert.equal(response.ok, false);
  assert.match(response.error ?? response.message ?? JSON.stringify(response), /oxfmt/);
});

test("a default profile dry run writes no oxfmt formatting script", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-oxfmt-removal-dry-run-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const recipe = buildRecipe("default", [...profileDefaults.default], "npm");
    const result = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    assert.equal(
      result.dependencies.some((dependency) => dependency.startsWith("oxfmt")),
      false,
    );

    await applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true });

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    const oxfmtScripts = Object.entries(packageFile.scripts ?? {}).filter(([, command]) =>
      command.includes("oxfmt"),
    );
    assert.deepEqual(oxfmtScripts, [], `Generated scripts still mention oxfmt: ${oxfmtScripts}`);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("inspect_project findings never mention Oxfmt", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-oxfmt-removal-inspect-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile(
      "package.json",
      `${JSON.stringify({ scripts: { format: "oxfmt --write ." } }, null, 2)}\n`,
    );

    const response = await callMcpTool("inspect_project", {
      recipe: buildRecipe("default", ["stylelint"], "npm"),
    });

    assert.equal(
      response.findings.some(
        ({ kind, path, message }) =>
          /oxfmt/i.test(kind) || /oxfmt/i.test(path ?? "") || /oxfmt/i.test(message ?? ""),
      ),
      false,
      `Oxfmt-aware findings remain: ${JSON.stringify(response.findings)}`,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});
