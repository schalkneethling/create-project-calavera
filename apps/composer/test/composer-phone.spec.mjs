import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

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

test("no element is wider than the 390px viewport", async ({ page }) => {
  await openComposer(page);

  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
});

test("every sticky bar and disclosure tap target is at least 44px tall", async ({ page }) => {
  await openComposer(page);

  const targets = [
    page.locator("#save-sticky"),
    page.locator("#css-overflow summary"),
    page.locator(".group-disclosure-toggle").first(),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test("the sticky bar Save button calls the same save path as the panel Save button", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__saveCalls = [];
    window.showSaveFilePicker = async (options) => {
      window.__saveCalls.push(options);
      return {
        createWritable: async () => ({
          write: async () => {},
          close: async () => {},
        }),
      };
    };
  });
  await openComposer(page);

  await page.locator("#save").click();
  await page.locator("#save-sticky").click();

  const calls = await page.evaluate(() => window.__saveCalls);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
});

test("the CSS overflow disclosure folds and unfolds the remaining rows", async ({ page }) => {
  await openComposer(page);
  const overflow = page.locator("#css-overflow");
  const overflowRow = page.locator("#css-rows .row[data-overflow]").first();

  await expect(overflow).toBeVisible();
  await expect(overflow).not.toHaveAttribute("open");
  await expect(overflowRow).toBeHidden();

  await overflow.locator("summary").click();
  await expect(overflow).toHaveAttribute("open", "");
  await expect(overflowRow).toBeVisible();

  await overflow.locator("summary").click();
  await expect(overflow).not.toHaveAttribute("open");
  await expect(overflowRow).toBeHidden();
});

test("each AI artifact group folds behind its own disclosure and tracks its selection count", async ({
  page,
}) => {
  await openComposer(page);
  const skills = page.locator('.artifact-group[data-group="Skills"]');
  const hooks = page.locator('.artifact-group[data-group="Hooks"]');
  const skillsToggle = skills.locator(".group-disclosure-toggle");
  const hooksToggle = hooks.locator(".group-disclosure-toggle");
  const skillsPanel = skills.locator('[role="tabpanel"]');
  const stickyCounts = page.locator("#sticky-bar-counts");

  const profile = await page.locator('[name="profile"]:checked').inputValue();
  await expect(page.locator("#sticky-bar-profile")).toHaveText(
    `${profile.charAt(0).toUpperCase()}${profile.slice(1)}, npm`,
  );
  await expect(stickyCounts).toHaveText(/, 0 artifacts$/);
  await expect(skillsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(hooksToggle).toHaveAttribute("aria-expanded", "false");
  await expect(skillsPanel).toBeHidden();
  await expect(skills.locator(".group-disclosure-count")).toHaveText(/^0 of \d+$/);

  await skillsToggle.click();
  await expect(skillsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(skillsPanel).toBeVisible();
  await expect(hooksToggle).toHaveAttribute("aria-expanded", "false");

  await skillsPanel.getByRole("checkbox", { name: "Calavera" }).check();
  await expect(skills.locator(".group-disclosure-count")).toHaveText(/^1 of \d+$/);
  await expect(stickyCounts).toHaveText(/, 1 artifact$/);

  await skillsToggle.click();
  await expect(skillsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(skillsPanel).toBeHidden();
});

test("the footer is visible above the sticky bar at the end of the page", async ({ page }) => {
  await openComposer(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  const footer = page.locator(".site-footer");
  await expect(footer).toBeInViewport();

  const footerBox = await footer.boundingBox();
  const barBox = await page.locator("#sticky-bar").boundingBox();
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(barBox.y + 1);
});
