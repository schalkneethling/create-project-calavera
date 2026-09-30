import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { integrationCatalog } from "../src/catalog.js";
import { callMcpTool, createMcpServer } from "../src/mcp.js";
import { listIntegrationOptions } from "../src/recipe.js";

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

test("describe_integration for varlock returns summary and homepage", async () => {
  const response = await callMcpTool("describe_integration", { id: "varlock" });

  assert.equal(response.id, "varlock");
  assert.equal(typeof response.summary, "string");
  assert.ok(response.summary.length > 0);
  assert.equal(new URL(/** @type {string} */ (response.homepage)).protocol, "https:");
});

test("standard MCP list_integrations and describe_integration satisfy their declared output schemas", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
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
  } finally {
    await client.close();
    await server.close();
  }
});
