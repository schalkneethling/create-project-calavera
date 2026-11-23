// #1192: the WebMCP specification (Draft Community Group Report, 19 November 2026, section 4.1
// "Extensions to Document") defines `modelContext` on Document, and Chrome's imperative API guide
// (last updated 20 November 2026) calls `document.modelContext.registerTool`. Neither documents
// `navigator.modelContext`, so the Composer registers through `document.modelContext` only.
// Section 4.2 defines `registerTool` as returning a promise that rejects, for example when a tool
// with the same name is already registered.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://registry.npmjs.org/create-project-calavera/latest", (route) =>
    route.fulfill({ json: { version: "6.2.1" } }),
  );
});

/** Collects the page's uncaught errors, including unhandled promise rejections. */
function collectPageErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("the Composer registers its tools on document.modelContext", async ({ page }) => {
  await page.addInitScript(() => {
    window.registeredWebMcpToolNames = [];
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool: async ({ name }) => {
          window.registeredWebMcpToolNames.push(name);
        },
      },
    });
  });
  await page.goto("/");

  await expect(page.locator("#webmcp-banner")).toBeVisible();
  expect(await page.evaluate(() => window.registeredWebMcpToolNames)).toContain("list_profiles");
});

test("the Composer registers nothing on navigator.modelContext, which no current source documents", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.registeredWebMcpToolNames = [];
    Object.defineProperty(navigator, "modelContext", {
      value: {
        registerTool: async ({ name }) => {
          window.registeredWebMcpToolNames.push(name);
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("#composer")).toBeVisible();

  await expect(page.locator("#webmcp-banner")).toBeHidden();
  expect(await page.evaluate(() => window.registeredWebMcpToolNames)).toEqual([]);
});

test("a rejected registration hides the banner and leaves no unhandled rejection", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  const consoleMessages = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.addInitScript(() => {
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool: async () => {
          throw new DOMException(
            "A tool with this name is already registered.",
            "InvalidStateError",
          );
        },
      },
    });
  });
  await page.goto("/");

  await expect
    .poll(() => consoleMessages.some((text) => text.includes("WebMCP tool registration failed.")))
    .toBe(true);
  await expect(page.locator("#webmcp-banner")).toBeHidden();
  expect(pageErrors).toEqual([]);
});
