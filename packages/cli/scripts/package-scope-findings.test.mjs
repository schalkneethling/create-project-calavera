// Issue #734: the stops for catalog `runsProjectTests` and `appliesAt: "package"` are generic, so
// they hold for an integration other than stryker. This file adds a test integration that applies
// only in a package and runs no tests; node --test runs each file in its own process, so the
// catalog of the other test files does not see it.
import assert from "node:assert/strict";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { callMcpTool } from "../src/mcp.js";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const packageFixture = {
  id: "package-fixture",
  label: "Package fixture",
  summary: "A test integration that applies only in a package.",
  homepage: "https://example.com",
  group: "Test",
  platform: "generic",
  status: "optional",
  appliesAt: "package",
  dependencies: [],
};
integrationCatalog.push(/** @type {any} */ (packageFixture));

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

/** @param {string[]} tools */
async function composeRecipe(tools) {
  const { recipe } = await callMcpTool("compose_recipe", {
    profile: "minimal",
    packageManager: "pnpm",
    tools,
  });
  return recipe;
}

test("at a workspace root, a package-scoped integration that runs no tests stops without Stryker's reason", async () => {
  await using fixture = await copyReleaseFixture("monorepo");

  await inDirectory(fixture.root, async () => {
    await assert.rejects(
      callMcpTool("dry_run_apply", { recipe: await composeRecipe(["package-fixture"]) }),
      (/** @type {unknown} */ error) =>
        error instanceof Error &&
        error.message ===
          "package-fixture applies in each workspace member, not at the workspace root. The dry run and apply stop before writing anything. Apply a recipe that selects package-fixture from each workspace member (cd <member> && pnpm dlx create-project-calavera apply --dry-run), and remove package-fixture from this recipe.",
    );
  });
});

test("at a workspace root, every stopping integration is named, one message per line", async () => {
  await using fixture = await copyReleaseFixture("monorepo");

  await inDirectory(fixture.root, async () => {
    await assert.rejects(
      callMcpTool("dry_run_apply", {
        recipe: await composeRecipe(["stryker", "package-fixture"]),
      }),
      (/** @type {unknown} */ error) => {
        assert.ok(error instanceof Error);
        const lines = error.message.split("\n");
        assert.equal(lines.length, 2, error.message);
        assert.match(lines[0], /^stryker applies in each workspace member/);
        assert.match(lines[1], /^package-fixture applies in each workspace member/);
        return true;
      },
    );
  });
});
