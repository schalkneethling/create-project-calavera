import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { integrationCatalog } from "../src/catalog.js";
import { callMcpTool, createMcpServer } from "../src/mcp.js";
import {
  buildRecipe,
  explainRecipeIntegrations,
  listIntegrationOptions,
  profileDefaults,
} from "../src/recipe.js";

const SUMMARY_MAX_LENGTH = 140;

test("every catalog integration has a concise summary and an https homepage", () => {
  for (const integration of integrationCatalog) {
    assert.equal(
      typeof integration.summary,
      "string",
      `${integration.id} summary must be a string`,
    );
    assert.ok(integration.summary.trim().length > 0, `${integration.id} summary must not be empty`);
    assert.ok(
      integration.summary.length < SUMMARY_MAX_LENGTH,
      `${integration.id} summary must be under ${SUMMARY_MAX_LENGTH} characters`,
    );
    assert.ok(
      integration.summary.endsWith("."),
      `${integration.id} summary must end with a period`,
    );

    assert.equal(
      typeof integration.homepage,
      "string",
      `${integration.id} homepage must be a string`,
    );
    const homepage = new URL(integration.homepage);
    assert.equal(homepage.protocol, "https:", `${integration.id} homepage must use https`);
  }
});

test("listIntegrationOptions exposes summary and homepage and prefixes the description with the summary", () => {
  for (const integration of listIntegrationOptions()) {
    assert.equal(typeof integration.summary, "string");
    assert.equal(typeof integration.homepage, "string");
    assert.ok(
      integration.description.startsWith(integration.summary),
      `${integration.id} description must be prefixed with its summary`,
    );
  }
});

// #228: an agent picks integrations from list_integrations alone, so each summary must say what
// that tool does. The generated description already carries the label, category, and status, so
// a summary that repeats them, or one shared with another integration, tells the agent nothing.
test("list_integrations returns a distinct summary per integration that is not the generated template", async () => {
  const response = await callMcpTool("list_integrations");
  const integrations = /** @type {Array<Record<string, string>>} */ (response.integrations);
  const summaries = integrations.map(({ summary }) => summary);

  assert.equal(integrations.length, integrationCatalog.length);
  assert.equal(new Set(summaries).size, summaries.length, "summaries must be distinct");
  for (const { id, label, group, status, summary } of integrations) {
    assert.doesNotMatch(summary, /Category:|Status:/, `${id} summary must not be templated`);
    assert.notEqual(summary, `${label}.`, `${id} summary must not be its label alone`);
    assert.notEqual(summary, `${group}.`, `${id} summary must not be its group alone`);
    assert.notEqual(summary, `${status}.`, `${id} summary must not be its status alone`);
    assert.ok(summary.split(/\s+/).length >= 8, `${id} summary must be a full sentence`);
  }

  const knip = integrations.find(({ id }) => id === "knip");
  assert.match(knip?.summary ?? "", /unused dependencies, exports, and files/);
});

// #228: the summaries are additive. Agents and saved recipes depend on the existing IDs, labels,
// groups, and statuses, so a change to any of them must be deliberate. A new integration does not
// need an entry here.
test("list_integrations keeps the existing IDs, labels, groups, and statuses", async () => {
  const expected = [
    ["editorconfig", "EditorConfig", "Project consistency", "recommended"],
    ["knip", "Knip", "Unused code", "optional"],
    ["html-validate", "HTML Validate", "HTML", "optional"],
    ["varlock", "Varlock", "Environment variables", "optional"],
    [
      "github-repository-controls",
      "GitHub repository controls",
      "Repository governance",
      "optional",
    ],
    ["stryker", "Stryker mutation testing", "Mutation testing", "optional"],
    ["react-doctor", "React Doctor", "React best practices", "framework-specific"],
    ["stylelint", "Stylelint", "CSS linting", "recommended"],
    ["stylelint-standard", "Stylelint standard config", "CSS linting", "recommended"],
    ["stylelint-order", "CSS property ordering", "CSS property ordering", "optional"],
    ["stylelint-baseline", "CSS Baseline", "CSS Baseline", "recommended"],
    ["stylelint-scss", "SCSS support", "CSS linting", "framework-specific"],
    ["stylelint-stylistic", "Stylelint stylistic rules", "CSS linting", "optional"],
    ["stylelint-logical-css", "Logical CSS", "CSS logical properties", "optional"],
    [
      "css-property-type-validator",
      "CSS property type validation",
      "CSS property type validation",
      "experimental",
    ],
  ];
  const response = await callMcpTool("list_integrations");
  const integrations = /** @type {Array<Record<string, string>>} */ (response.integrations);

  for (const [id, label, group, status] of expected) {
    const integration = integrations.find((candidate) => candidate.id === id);
    assert.deepEqual(
      [integration?.id, integration?.label, integration?.group, integration?.status],
      [id, label, group, status],
    );
  }
});

test("describe_integration for varlock returns summary and homepage", async () => {
  const response = await callMcpTool("describe_integration", { id: "varlock" });

  assert.equal(response.id, "varlock");
  assert.equal(typeof response.summary, "string");
  assert.ok(response.summary.length > 0);
  assert.equal(new URL(/** @type {string} */ (response.homepage)).protocol, "https:");
});

test("explain_recipe returns summary and homepage for each integration", () => {
  const explanation = explainRecipeIntegrations(buildRecipe("default", profileDefaults.default));

  assert.ok(explanation.length > 0);
  for (const integration of explanation) {
    const entry = integrationCatalog.find(({ id }) => id === integration.id);
    assert.equal(integration.summary, entry?.summary);
    assert.equal(integration.homepage, entry?.homepage);
  }
});

test("standard MCP list_integrations and describe_integration satisfy their declared output schemas", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // The client caches each tool's advertised output schema on listTools and validates
    // structuredContent against it; without this call the advertised schema goes untested.
    await client.listTools();

    const listResult = await client.callTool({ name: "list_integrations", arguments: {} });
    const integrations = listResult.structuredContent?.integrations;

    assert.ok(Array.isArray(integrations));
    assert.equal(
      integrations.every(
        (integration) =>
          typeof integration.summary === "string" && typeof integration.homepage === "string",
      ),
      true,
    );

    const describeResult = await client.callTool({
      name: "describe_integration",
      arguments: { id: "varlock" },
    });
    const described = describeResult.structuredContent;

    assert.equal(described?.id, "varlock");
    assert.ok(described?.summary.length > 0);
    assert.equal(new URL(described?.homepage).protocol, "https:");

    // Entries with platform config blocks (stylelint, htmlValidate) must pass the advertised schema.
    for (const { id } of integrationCatalog) {
      const result = await client.callTool({ name: "describe_integration", arguments: { id } });
      assert.equal(result.structuredContent?.id, id);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
