import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/composer-recipes.json", import.meta.url), "utf8"),
);

/** @param {import("@playwright/test").Page} page @param {string} version */
async function openComposer(page, version = "4.0.0") {
  await page.route("https://registry.npmjs.org/create-project-calavera/latest", (route) =>
    route.fulfill({ json: { version } }),
  );
  await page.goto("/");
  await expect(page.locator("#cli-version")).toHaveText(
    `create-project-calavera ${version} on npm`,
  );
}

/** @param {import("@playwright/test").Page} page @param {string} id */
function artifactRow(page, id) {
  return page.locator(".row", { has: page.locator(`[name="aiArtifact"][value="${id}"]`) });
}

/** @param {import("@playwright/test").Page} page */
async function recipeOutput(page) {
  return JSON.parse(await page.locator("#output").textContent());
}

test("the new project command is offered only from CLI 4.0.0", async ({ page }) => {
  await openComposer(page, "3.0.0");
  await expect(page.getByRole("heading", { name: "Starting from nothing?" })).toBeHidden();
  await expect(page.getByRole("radio", { name: "Default" })).toBeHidden();

  await openComposer(page, "4.0.0");
  await expect(page.getByRole("heading", { name: "Starting from nothing?" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Default" })).toBeAttached();
});

test("clicking a row checkbox toggles the selection without toggling its details", async ({
  page,
}) => {
  await openComposer(page);
  const row = artifactRow(page, "skill-calavera");
  const checkbox = row.getByRole("checkbox", { name: "Calavera" });
  const details = row.locator("details");

  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(details).not.toHaveAttribute("open");

  await row.locator("summary").click();
  await expect(details).toHaveAttribute("open");
  await expect(checkbox).toBeChecked();
  await expect(
    row.getByRole("link", { name: "@schalkneethling/calavera-skill-calavera" }),
  ).toHaveAttribute(
    "href",
    "https://www.npmjs.com/package/@schalkneethling/calavera-skill-calavera",
  );

  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
  await expect(details).toHaveAttribute("open");
});

test("integration rows expand to the catalog summary and homepage", async ({ page }) => {
  await openComposer(page);
  const row = page.locator(".row", { has: page.locator('[name="integration"][value="varlock"]') });

  await row.locator("summary").click();
  await expect(row.locator("details")).toHaveAttribute("open");
  await expect(row.getByRole("checkbox", { name: "Varlock" })).not.toBeChecked();
  await expect(row.getByText(/declarative schema/)).toBeVisible();
  await expect(row.getByRole("link", { name: "varlock.dev" })).toHaveAttribute(
    "href",
    "https://varlock.dev",
  );
});

test("switching artifact tabs keeps selections", async ({ page }) => {
  await openComposer(page);
  await page.getByRole("checkbox", { name: "Calavera" }).check();
  await page.getByRole("tab", { name: /Hooks/ }).click();
  await expect(page.getByRole("tab", { name: /Hooks/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("checkbox", { name: "Block dangerous commands" }).check();

  await page.getByRole("tab", { name: /Skills/ }).click();
  await expect(page.getByRole("checkbox", { name: "Calavera" })).toBeChecked();
  await page.getByRole("tab", { name: /Skills/ }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Hooks/ })).toBeFocused();
  await expect(page.getByRole("checkbox", { name: "Block dangerous commands" })).toBeChecked();

  expect((await recipeOutput(page)).ai).toEqual([
    { id: "skill-calavera" },
    { id: "hook-block-dangerous-commands", target: "claude-code" },
  ]);
});

test("Install into sets the target of every selected artifact", async ({ page }) => {
  await openComposer(page);
  await page.getByRole("tab", { name: /Hooks/ }).click();
  await page.getByRole("checkbox", { name: "Auto-approve safe commands" }).check();
  await page.getByRole("checkbox", { name: "Block dangerous commands" }).check();
  await page.getByRole("tab", { name: /Agents/ }).click();
  await page.getByRole("checkbox", { name: "Technical devil's advocate" }).check();

  await page.getByLabel("Install into", { exact: true }).selectOption("codex");

  for (const id of [
    "hook-auto-approve-safe-commands",
    "hook-block-dangerous-commands",
    "agent-technical-devils-advocate",
  ]) {
    await expect(page.locator(`[data-ai-target="${id}"]`)).toHaveValue("codex");
  }
  expect((await recipeOutput(page)).ai.map(({ target }) => target)).toEqual([
    "codex",
    "codex",
    "codex",
  ]);
});

test("re-selecting an artifact keeps its own target over Install into", async ({ page }) => {
  await openComposer(page);
  await page.getByRole("tab", { name: /Hooks/ }).click();
  const row = artifactRow(page, "hook-block-dangerous-commands");
  const checkbox = row.getByRole("checkbox", { name: "Block dangerous commands" });
  const target = row.locator('[data-ai-target="hook-block-dangerous-commands"]');

  await checkbox.check();
  await row.locator("summary").click();
  await target.selectOption("codex");
  await checkbox.uncheck();
  await checkbox.check();

  await expect(target).toHaveValue("codex");
  expect((await recipeOutput(page)).ai).toEqual([
    { id: "hook-block-dangerous-commands", target: "codex" },
  ]);
});

test("Copy without the Clipboard API leaves the button unchanged and throws nothing", async ({
  page,
}) => {
  /** @type {Error[]} */
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
  await openComposer(page);

  const copy = page.locator("[data-copy]").first();
  await copy.click();

  await expect(copy).toHaveText("Copy");
  expect(pageErrors).toEqual([]);
});

test("the JSON output for a fixed selection equals the pinned recipe", async ({ page }) => {
  await openComposer(page);
  await page.getByRole("radio", { name: "Minimal" }).check();
  await page.getByRole("radio", { name: "pnpm" }).check();
  await page.getByRole("checkbox", { name: "CSS Baseline" }).check();
  await page.getByRole("checkbox", { name: "GitHub repository controls" }).check();
  await page.getByLabel("Availability").selectOption("2024");
  await page.getByLabel("Severity").selectOption("error");
  await page.getByLabel("Repository (owner/name)").fill("octocat/example");
  await page.getByLabel("Other required checks (optional, comma-separated)").fill("quality, build");
  await page.getByLabel("Other required checks (optional, comma-separated)").blur();

  await page.getByRole("checkbox", { name: "Calavera" }).check();
  await page.getByRole("tab", { name: /Hooks/ }).click();
  const hook = artifactRow(page, "hook-block-dangerous-commands");
  await hook.getByRole("checkbox").check();
  await hook.locator("summary").click();
  await hook.getByLabel("Install Block dangerous commands into").selectOption("codex");
  await page.getByRole("tab", { name: /Agents/ }).click();
  await page.getByRole("checkbox", { name: "Technical devil's advocate" }).check();

  // toHaveText normalizes whitespace; compare the raw text so indentation and line breaks count.
  await expect
    .poll(() => page.locator("#output").textContent())
    .toBe(JSON.stringify(fixtures["page-selection"], null, 2));
  await expect(page.locator("#recipe-summary li")).toHaveText([
    "Minimal profile",
    "pnpm",
    "3 integrations",
    "3 artifacts",
  ]);
  await expect(page.locator("#next-commands code")).toHaveText([
    "pnpm dlx create-project-calavera apply --dry-run",
    "pnpm dlx create-project-calavera apply",
  ]);
});

test("repository controls require CodeQL results by default and accept an empty checks list", async ({
  page,
}) => {
  await openComposer(page);
  await page.getByRole("radio", { name: "Minimal" }).check();
  await page.getByRole("checkbox", { name: "GitHub repository controls" }).check();
  await page.getByLabel("Repository (owner/name)").fill("octocat/example");
  await page.getByLabel("Repository (owner/name)").blur();

  const group = page.getByRole("group", { name: "Merge requirements" });
  const codeql = group.getByRole("checkbox", { name: "Require CodeQL results" });
  const checks = group.getByLabel("Other required checks (optional, comma-separated)");

  await expect(codeql).toBeChecked();
  await expect(checks).toHaveValue("");
  await expect(checks).not.toHaveAttribute("placeholder", /.+/);
  await expect(checks).not.toHaveAttribute("required", /.*/);
  await expect(checks).toHaveAccessibleDescription(/Empty is valid: no status checks are required/);
  await expect(codeql).toHaveAccessibleDescription(
    /you do not need to enter CodeQL as a status check/,
  );

  let options = (await recipeOutput(page)).integrationOptions["github-repository-controls"];
  expect(options.requiredChecks).toEqual([]);
  expect(options.requireCodeqlResults).toBe(true);

  await codeql.uncheck();
  options = (await recipeOutput(page)).integrationOptions["github-repository-controls"];
  expect(options.requireCodeqlResults).toBe(false);
  expect(options.requiredChecks).toEqual([]);

  await expect(group.getByRole("link", { name: "Available rules for rulesets" })).toHaveAttribute(
    "href",
    "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets",
  );
  await expect(
    group.getByRole("link", { name: "Creating rulesets for a repository" }),
  ).toHaveAttribute(
    "href",
    "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository",
  );
});
