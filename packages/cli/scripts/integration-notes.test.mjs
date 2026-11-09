// Issue #735: the Composer and the MCP server say where an integration works. The notes come
// from catalog metadata (`appliesAt`, `runsVitestTests`, `standaloneScript`), so a client that
// lists or describes an integration reads the Vite+ requirement, the `test:mutation` script, and
// the workspace-member scope without reading the README.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, describeIntegrationResponse, listIntegrationOptions } from "../src/recipe.js";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const rootNote = "Applies at the repository root.";
const viteNote = "Needs a project that Vite+ manages.";
const scriptNote = "Adds a test:mutation script, which quality does not run.";
const packageNote =
  "Applies in a single-package project or a workspace member, not at a workspace root.";

test("stryker lists its three conditions as notes, in a fixed order", () => {
  const { notes } = describeIntegrationResponse("stryker");

  assert.deepEqual(notes, [viteNote, scriptNote, packageNote]);
});

test("the stryker description ends with the notes, after the catalog sentence", () => {
  const { description } = describeIntegrationResponse("stryker");

  assert.ok(description.endsWith(` ${[viteNote, scriptNote, packageNote].join(" ")}`));
});

test("github-repository-controls keeps only its repository-root note", () => {
  const { notes, description } = describeIntegrationResponse("github-repository-controls");

  assert.deepEqual(notes, [rootNote]);
  assert.ok(description.endsWith(` ${rootNote}`));
});

test("an integration without placement metadata has no notes", () => {
  const withoutMetadata = integrationCatalog.filter(
    ({ appliesAt, runsVitestTests, standaloneScript }) =>
      !appliesAt && !runsVitestTests && !standaloneScript,
  );

  assert.ok(withoutMetadata.length > 0);
  for (const { id } of withoutMetadata) {
    const integration = listIntegrationOptions().find((candidate) => candidate.id === id);
    assert.deepEqual(integration?.notes, [], id);
    assert.equal(integration?.description.includes("Applies"), false, id);
  }
});

test("list_integrations, describe_integration, and explain_recipe carry the stryker notes", async () => {
  const listed = await callMcpTool("list_integrations", {});
  const described = await callMcpTool("describe_integration", { id: "stryker" });
  const explained = await callMcpTool("explain_recipe", {
    recipe: buildRecipe("minimal", ["stryker"], "npm"),
  });
  const fromList = listed.integrations.find(({ id }) => id === "stryker");
  const reason = explained.integrations.find(({ id }) => id === "stryker").reason;

  for (const text of [fromList.description, described.description, reason]) {
    assert.ok(text.includes(viteNote), text);
    assert.ok(text.includes(scriptNote), text);
    assert.ok(text.includes(packageNote), text);
  }
  assert.deepEqual(fromList.notes, [viteNote, scriptNote, packageNote]);
});

test("the script the note names is the script apply plans", async () => {
  const { standaloneScript } = integrationCatalog.find(({ id }) => id === "stryker");
  await using fixture = await copyReleaseFixture("library");
  await mkdir(join(fixture.root, "tests"));
  await writeFile(join(fixture.root, "tests/index.test.ts"), "export {};\n");

  const originalDirectory = process.cwd();
  process.chdir(fixture.root);
  try {
    const dryRun = await callMcpTool("dry_run_apply", {
      recipe: buildRecipe("minimal", ["stryker"], "pnpm"),
    });
    const manifestChange = dryRun.result.changes.find(
      ({ type, path }) => type === "update" && path === "package.json",
    );

    assert.equal(standaloneScript, "test:mutation");
    assert.ok(manifestChange.scripts.includes(standaloneScript), JSON.stringify(manifestChange));
    assert.ok(scriptNote.includes(standaloneScript));
  } finally {
    process.chdir(originalDirectory);
  }
});
