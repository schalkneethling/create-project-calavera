import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, profileDefaults } from "../src/recipe.js";

function hasOxfmtId(ids) {
  return ids.some((id) => id.startsWith("oxfmt"));
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
        id.startsWith("oxfmt") ||
        platform === "oxfmt" ||
        (dependencies ?? []).includes("oxfmt") ||
        (includes ?? []).includes("oxfmt"),
    ),
    false,
  );
});

test("list_profiles keeps the modern profile without any Oxfmt default", async () => {
  const response = await callMcpTool("list_profiles");
  const modern = response.profiles.find(({ id }) => id === "modern");

  assert.ok(modern, "The modern profile must still be listed.");
  assert.equal(
    hasOxfmtId(modern.defaultIntegrations),
    false,
    `Oxfmt ids still default for modern: ${modern.defaultIntegrations.join(", ")}`,
  );
  assert.equal(hasOxfmtId(profileDefaults.modern), false);
});

test("compose_recipe rejects the oxfmt id as unknown", async () => {
  await assert.rejects(
    () =>
      callMcpTool("compose_recipe", {
        profile: "modern",
        packageManager: "npm",
        tools: ["oxfmt"],
      }),
    /oxfmt/,
  );
});

test("validate_recipe rejects a recipe that requests oxfmt", async () => {
  const recipe = {
    version: 1,
    profile: "modern",
    packageManager: "npm",
    integrations: ["oxfmt"],
    scripts: { format: true },
  };

  const response = await callMcpTool("validate_recipe", { recipe });

  assert.equal(response.ok, false);
  assert.match(response.error ?? response.message ?? JSON.stringify(response), /oxfmt/);
});

test("a modern profile dry run writes no oxfmt formatting script", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-oxfmt-removal-dry-run-"),
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
      recipe: buildRecipe("classic", ["prettier"], "npm"),
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
