import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, profileDefaults } from "../src/recipe.js";

async function assertPathMissing(path) {
  await assert.rejects(() => stat(path), /ENOENT/, `${path} should not exist`);
}

function hasOxlintId(ids) {
  return ids.some((id) => id.startsWith("oxlint"));
}

test("list_integrations reports no Oxlint integration and no Oxlint plugin platform", async () => {
  const response = await callMcpTool("list_integrations");
  const ids = response.integrations.map(({ id }) => id);

  assert.equal(hasOxlintId(ids), false, `Oxlint ids still listed: ${ids.join(", ")}`);
  assert.equal(
    response.integrations.some(({ platform }) => platform === "oxlint-plugin"),
    false,
  );
  assert.equal(
    integrationCatalog.some(
      ({ id, platform, includes }) =>
        id.startsWith("oxlint") ||
        platform === "oxlint-plugin" ||
        (includes ?? []).includes("oxlint"),
    ),
    false,
  );
});

test("list_profiles keeps the modern profile without any Oxlint default", async () => {
  const response = await callMcpTool("list_profiles");
  const modern = response.profiles.find(({ id }) => id === "modern");

  assert.ok(modern, "The modern profile must still be listed.");
  assert.equal(
    hasOxlintId(modern.defaultIntegrations),
    false,
    `Oxlint ids still default for modern: ${modern.defaultIntegrations.join(", ")}`,
  );
  assert.equal(hasOxlintId(profileDefaults.modern), false);
});

test("compose_recipe rejects the oxlint id as unknown", async () => {
  await assert.rejects(
    () =>
      callMcpTool("compose_recipe", {
        profile: "modern",
        packageManager: "npm",
        tools: ["oxlint"],
      }),
    /oxlint/,
  );
});

test("validate_recipe rejects a recipe that requests oxlint-react", async () => {
  const recipe = {
    version: 1,
    profile: "modern",
    packageManager: "npm",
    integrations: ["oxlint-react"],
    scripts: { lint: true },
  };

  const response = await callMcpTool("validate_recipe", { recipe });

  assert.equal(response.ok, false);
  assert.match(response.error ?? response.message ?? JSON.stringify(response), /oxlint-react/);
});

test("a modern profile dry run plans no oxlint.json and writes no oxlint script", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-oxlint-removal-dry-run-"),
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
      result.changes.some(({ path }) => path === "oxlint.json"),
      false,
    );
    assert.equal(
      result.dependencies.some((dependency) => dependency.startsWith("oxlint")),
      false,
    );

    await applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true });
    await assertPathMissing("oxlint.json");

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    const oxlintScripts = Object.entries(packageFile.scripts ?? {}).filter(([, command]) =>
      command.includes("oxlint"),
    );
    assert.deepEqual(oxlintScripts, [], `Generated scripts still mention oxlint: ${oxlintScripts}`);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("inspect_project treats an existing oxlint.json as a file Calavera does not know", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-oxlint-removal-inspect-"),
  );

  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile("oxlint.json", `${JSON.stringify({ plugins: ["typescript"] }, null, 2)}\n`);

    const response = await callMcpTool("inspect_project", {
      recipe: buildRecipe("classic", ["stylelint"], "npm"),
    });

    assert.equal(
      response.files.includes("oxlint.json"),
      false,
      "Calavera no longer inspects Oxlint configuration files.",
    );
    assert.equal(
      response.findings.some(({ kind }) => kind === "equivalent-tooling"),
      false,
    );
    assert.equal(
      response.findings.some(
        ({ kind, path, message }) =>
          /oxlint/i.test(kind) || /oxlint/i.test(path ?? "") || /oxlint/i.test(message ?? ""),
      ),
      false,
      `Oxlint-aware findings remain: ${JSON.stringify(response.findings)}`,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});
