// ADR-0018 Decision 2 (#1051): the Composer registers each tool it shares with the MCP server
// with the JSON Schema that the core generates. packages/cli/scripts/shared-tool-schemas.test.mjs
// checks the MCP side and compares the two forms.
import { expect, test } from "@playwright/test";

import { webMcpToolSchemas } from "../../../packages/cli/src/tool-schemas.js";

test("the Composer registers the core's schemas for every tool it shares with MCP", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.registeredWebMcpTools = [];
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool: ({ name, inputSchema, outputSchema }) => {
          window.registeredWebMcpTools.push(structuredClone({ name, inputSchema, outputSchema }));
        },
      },
    });
  });
  await page.route("https://registry.npmjs.org/create-project-calavera/latest", (route) =>
    route.fulfill({ json: { version: "6.2.1" } }),
  );
  await page.goto("/");
  await page.waitForFunction(() => window.registeredWebMcpTools.length > 0);

  const registered = new Map(
    (await page.evaluate(() => window.registeredWebMcpTools)).map((tool) => [tool.name, tool]),
  );
  const expected = webMcpToolSchemas();

  for (const [name, { inputSchema, outputSchema }] of Object.entries(expected)) {
    expect(registered.get(name)?.inputSchema, name).toEqual(inputSchema);
    expect(registered.get(name)?.outputSchema, name).toEqual(outputSchema);
  }
  expect(registered.get("list_integrations")?.outputSchema).toBeDefined();
  expect(registered.get("describe_integration")?.outputSchema).toBeDefined();
});
