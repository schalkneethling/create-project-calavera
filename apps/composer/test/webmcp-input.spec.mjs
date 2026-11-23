// #1176: the WebMCP specification does not have the browser check a tool's arguments against its
// inputSchema, so every Composer handler checks its own input. These tests call each registered
// execute function directly, as a browser that skips schema enforcement would, and each case
// fails when the handler's check is removed: the refusal is a ToolInputError, not the core's own
// error or a result.
import { expect, test } from "@playwright/test";

import { nodeOnlyInputMessage } from "../../../packages/cli/src/recipe.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.webMcpTools = new Map();
    Object.defineProperty(document, "modelContext", {
      value: { registerTool: (tool) => window.webMcpTools.set(tool.name, tool) },
    });
    // download_recipe saves through a link click; record it instead of saving a file.
    window.downloads = 0;
    HTMLAnchorElement.prototype.click = () => {
      window.downloads += 1;
    };
  });
  await page.route("https://registry.npmjs.org/create-project-calavera/latest", (route) =>
    route.fulfill({ json: { version: "6.2.1" } }),
  );
  await page.goto("/");
  await page.waitForFunction(() => window.webMcpTools.size > 0);
});

/** Calls a registered tool's execute function and reports how it settled. */
function callTool(page, name, input) {
  return page.evaluate(
    async ([toolName, toolInput]) => {
      try {
        return { result: await window.webMcpTools.get(toolName).execute(toolInput) };
      } catch (error) {
        return { error: { name: error.name, message: error.message, path: error.path } };
      }
    },
    [name, input],
  );
}

// A recipe that compose_recipe returns for the default profile.
const recipe = {
  $schema: "https://calavera.schalkneethling.com/calavera.config.schema.json",
  version: 1,
  profile: "default",
  packageManager: "npm",
  integrations: ["editorconfig", "stylelint", "stylelint-standard", "stylelint-baseline"],
  scripts: { lint: true, "lint:fix": true, quality: true },
};

const refusals = [
  // The core reads no input for these tools, so only the schema refuses a non-object.
  ["list_profiles", [], "Invalid input: expected an object."],
  ["list_ai_artifacts", [], "Invalid input: expected an object."],
  ["list_baseline_targets", [], "Invalid input: expected an object."],
  // The core reads any profile, so only the schema refuses a non-object.
  ["list_integrations", [], "Invalid input: expected an object."],
  // The core reads a missing ID as "undefined"; the check gives the core's message.
  ["describe_integration", {}, "Unknown integration: undefined."],
  [
    "describe_baseline_target",
    { target: " widely" },
    "Baseline target must be widely, newly, or a year from 2015 through 2026.",
  ],
  // The core reads any query and limit, so only the schema refuses a non-object.
  ["search_baseline_features", [], "Invalid input: expected an object."],
  ["recommend_baseline_target", { features: [] }, "Select at least one Baseline feature."],
  // A Node.js-only part, which the core would record.
  [
    "compose_recipe",
    { profile: "default", aiArtifacts: [{ id: "skill-code-review", inputs: {} }] },
    nodeOnlyInputMessage("aiArtifacts[0].inputs"),
  ],
  // validate_recipe answers any recipe with its result, so only the schema refuses a non-object.
  ["validate_recipe", [], "Invalid input: expected an object."],
  ["explain_recipe", { recipe: [] }, "Recipe must be an object."],
  // Without the check, downloadRecipe reads no recipe from an array and saves the page's own.
  ["download_recipe", [], "Invalid input: expected an object."],
  // The core refuses these too, and its message, not the schema's, comes back.
  [
    "compose_recipe",
    { profile: "default", packageManager: " npm" },
    "Invalid packageManager:  npm. Allowed values: npm, pnpm, yarn, bun.",
  ],
  ["download_recipe", { recipe: [] }, "Recipe must be an object."],
];

for (const [name, input, message] of refusals) {
  test(`${name} refuses ${JSON.stringify(input)} before it calls the core`, async ({ page }) => {
    const { result, error } = await callTool(page, name, input);
    expect(result).toBeUndefined();
    expect(error).toEqual({ name: "ToolInputError", message, path: expect.any(String) });
  });
}

test("every registered tool has a refusal case", async ({ page }) => {
  const names = await page.evaluate(() => [...window.webMcpTools.keys()]);
  expect(names.sort()).toEqual([...new Set(refusals.map(([name]) => name))].sort());
});

test("compose_recipe refuses artifact inputs in the handler, so no recipe records them", async ({
  page,
}) => {
  const input = {
    profile: "default",
    aiArtifacts: [
      { id: "skill-code-review" },
      { id: "skill-protected-branch-guard", inputs: { protectedBranch: "main" } },
    ],
  };

  const { result, error } = await callTool(page, "compose_recipe", input);

  expect(result).toBeUndefined();
  expect(error).toEqual({
    name: "ToolInputError",
    message: nodeOnlyInputMessage("aiArtifacts[1].inputs"),
    path: "aiArtifacts[1].inputs",
  });
  // The same input without inputs composes, so the refusal is about inputs alone.
  delete input.aiArtifacts[1].inputs;
  const composed = await callTool(page, "compose_recipe", input);
  expect(composed.error).toBeUndefined();
  expect(composed.result.recipe.ai.some((item) => "inputs" in item)).toBe(false);
});

test("download_recipe saves nothing when it refuses its input", async ({ page }) => {
  await callTool(page, "download_recipe", []);
  expect(await page.evaluate(() => window.downloads)).toBe(0);
  // A recipe downloads, so the count would show a save.
  expect((await callTool(page, "download_recipe", { recipe })).error).toBeUndefined();
  expect(await page.evaluate(() => window.downloads)).toBe(1);
});

// #1176: values the core tolerates, which the declared schemas refused until #1176 widened them
// (ADR-0018 Decision 6). The handlers enforce the schemas, so each must still answer.
test("the handlers answer values the core tolerates, as the Composer did before #1176", async ({
  page,
}) => {
  const allIntegrations = await callTool(page, "list_integrations", {});
  for (const profile of [null, "", false, 0]) {
    const listed = await callTool(page, "list_integrations", { profile });
    expect(listed.error, `profile ${JSON.stringify(profile)}`).toBeUndefined();
    expect(listed.result.integrations).toEqual(allIntegrations.result.integrations);
    expect(listed.result.profile).toBeNull();
  }
  // A value that is not a profile ID lists no integrations, as the Composer did on main.
  for (const profile of ["unknown", "DEFAULT", " default"]) {
    expect(await callTool(page, "list_integrations", { profile })).toEqual({
      result: { profile, integrations: [] },
    });
  }
  // ADR-0011: the core refuses a removed profile ID with a message naming its replacement.
  expect(await callTool(page, "list_integrations", { profile: "modern" })).toEqual({
    error: {
      name: "Error",
      message:
        "Invalid profile: modern. Allowed values: default, minimal. The modern profile was removed; use default instead.",
      path: undefined,
    },
  });
  // The core reads String(id), so an array that holds the ID describes the integration.
  const described = await callTool(page, "describe_integration", { id: ["stylelint"] });
  expect(described.error).toBeUndefined();
  expect(described.result.id).toBe("stylelint");
  for (const input of [
    {},
    { query: null },
    { query: "grid", limit: null },
    { query: "", limit: 500 },
  ]) {
    const searched = await callTool(page, "search_baseline_features", input);
    expect(searched.error, JSON.stringify(input)).toBeUndefined();
    expect(searched.result.features.length).toBeGreaterThan(0);
  }
  for (const absent of [null, false, 0, ""]) {
    const composed = await callTool(page, "compose_recipe", {
      profile: "default",
      tools: absent,
      aiArtifacts: absent,
    });
    expect(composed.error, JSON.stringify(absent)).toBeUndefined();
  }
  for (const input of [{}, { recipe: [] }, { recipe: "default" }]) {
    expect(await callTool(page, "validate_recipe", input)).toEqual({
      result: { ok: false, errors: ["Recipe must be an object."] },
    });
  }
  // download_recipe ignores a field it does not read, as it did before #1176.
  expect((await callTool(page, "download_recipe", { recipe, extra: 1 })).error).toBeUndefined();
});
