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
    Object.defineProperty(navigator, "modelContext", {
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

// A recipe that compose_recipe returns for the default profile, so only the extra field is wrong.
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
  // The core lists no integration for an unknown profile; the check gives the core's message.
  [
    "list_integrations",
    { profile: "DEFAULT" },
    expect.stringMatching(/^Invalid profile: DEFAULT\. Allowed values: /),
  ],
  // The core reads String(id), so it would describe the integration.
  ["describe_integration", { id: ["stylelint"] }, "Invalid id: expected a string."],
  [
    "describe_baseline_target",
    { target: " widely" },
    "Baseline target must be widely, newly, or a year from 2015 through 2026.",
  ],
  // The core falls back to its default limit.
  [
    "search_baseline_features",
    { query: "grid", limit: 0 },
    "Invalid limit: expected a number of at least 1.",
  ],
  ["recommend_baseline_target", { features: [] }, "Select at least one Baseline feature."],
  // The core reads a falsy tools list as absent.
  [
    "compose_recipe",
    { profile: "default", tools: false },
    "Invalid tools: expected an array or a null.",
  ],
  // The core returned { ok: false } for this before; the check refuses it as the schema does.
  ["validate_recipe", { recipe: [] }, "Recipe must be an object."],
  ["explain_recipe", { recipe: [] }, "Recipe must be an object."],
  // The core never sees the extra field, so the recipe would download.
  ["download_recipe", { recipe, extra: 1 }, "Invalid extra: is not a known field."],
  // The core refuses these too, and its message, not the schema's, comes back.
  ["describe_integration", { id: 5 }, "Unknown integration: 5."],
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
  await callTool(page, "download_recipe", { recipe, extra: 1 });
  expect(await page.evaluate(() => window.downloads)).toBe(0);
  // The same recipe without the extra field downloads, so the count would show a save.
  expect((await callTool(page, "download_recipe", { recipe })).error).toBeUndefined();
  expect(await page.evaluate(() => window.downloads)).toBe(1);
});
