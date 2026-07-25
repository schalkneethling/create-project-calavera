import { expect, test } from "@playwright/test";

const formats = [
  { id: "calavera", name: "Calavera" },
  { id: "rule", name: "Stylelint rule" },
  { id: "config", name: "Stylelint config" },
];

async function expectSelected(page, selectedId) {
  for (const { id, name } of formats) {
    const selected = id === selectedId;
    await expect(page.getByRole("tab", { name })).toHaveAttribute(
      "aria-selected",
      String(selected),
    );
    const panel = page.locator(`#output-panel-${id}`);
    if (selected) await expect(panel).toBeVisible();
    else await expect(panel).toBeHidden();
  }
}

test("generated-output tabs implement the APG interaction and copy each format", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.copiedOutput = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText(value) {
          window.copiedOutput.push(value);
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto("/");

  for (const { id, name } of formats) {
    const tab = page.getByRole("tab", { name });
    const panel = page.locator(`#output-panel-${id}`);
    await expect(tab).toHaveAttribute("aria-controls", `output-panel-${id}`);
    await expect(panel).toHaveAttribute("aria-labelledby", `output-tab-${id}`);
  }
  await expectSelected(page, "calavera");

  const calaveraTab = page.getByRole("tab", { name: "Calavera" });
  const ruleTab = page.getByRole("tab", { name: "Stylelint rule" });
  const configTab = page.getByRole("tab", { name: "Stylelint config" });

  await ruleTab.click();
  await expectSelected(page, "rule");

  await ruleTab.press("ArrowRight");
  await expect(configTab).toBeFocused();
  await expect(configTab).toHaveAttribute("tabindex", "0");
  await expectSelected(page, "rule");

  await configTab.press("Home");
  await expect(calaveraTab).toBeFocused();
  await expectSelected(page, "rule");

  await calaveraTab.press("End");
  await expect(configTab).toBeFocused();
  await expectSelected(page, "rule");

  await configTab.press("Enter");
  await expectSelected(page, "config");

  await configTab.press("ArrowLeft");
  await expect(ruleTab).toBeFocused();
  await expectSelected(page, "config");

  await ruleTab.press("Space");
  await expectSelected(page, "rule");

  for (const { id, name } of formats) {
    await page.getByRole("tab", { name }).click();
    const panel = page.getByRole("tabpanel", { name });
    const output = await panel.locator("[data-generated-output]").textContent();
    await panel.getByRole("button", { name: "Copy" }).click();
    await expect.poll(() => page.evaluate(() => window.copiedOutput.at(-1))).toBe(output);
    await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
    await expectSelected(page, id);
  }
});
