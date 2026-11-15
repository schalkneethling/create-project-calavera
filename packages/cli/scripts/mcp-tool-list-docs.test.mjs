// #839: the README and `--help` tell people which MCP tools to confirm before composing a
// recipe, and permission allow-lists are built from that list, so a tool the documents leave
// out gets denied. These tests compare both lists with the tools the server registers.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));
const readmeUrl = new URL("../../../README.md", import.meta.url);
const workflowDocUrl = new URL("../../../docs/agent-first-calavera-workflow.md", import.meta.url);

const README_MARKER = "Confirm the Calavera MCP tools are exposed:";
const WORKFLOW_DOC_MARKER = "Calavera MCP tools are exposed:";
const HELP_MARKER = "Confirm these tools are visible before composing a recipe:";
const TOOL_NAME_PATTERN = /\b[a-z]+(?:_[a-z]+)+\b/g;

/**
 * The tool names a running server advertises to an MCP client, sorted.
 *
 * @returns {Promise<string[]>}
 */
async function registeredToolNames() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-docs-drift-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools } = await client.listTools();
    return tools.map(({ name }) => name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * The text from the marker up to the next numbered step or blank line, so the parse covers
 * the whole list even when it wraps across lines.
 *
 * @param {string} text
 * @param {string} marker
 * @param {string} source
 * @returns {string}
 */
function listAfterMarker(text, marker, source) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `${source} no longer contains "${marker}"`);
  assert.equal(
    text.indexOf(marker, start + marker.length),
    -1,
    `${source} contains "${marker}" more than once`,
  );
  const rest = text.slice(start + marker.length);
  const end = rest.search(/\n\s*\n|\n\s*\d+\.\s/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * @param {string} list
 * @returns {string[]}
 */
function toolNamesIn(list) {
  return [...list.matchAll(TOOL_NAME_PATTERN)].map(([name]) => name).sort();
}

test("the README lists every tool the MCP server registers, and no others", async () => {
  const readme = await readFile(readmeUrl, "utf8");
  const documented = toolNamesIn(listAfterMarker(readme, README_MARKER, "README.md"));

  assert.deepEqual(documented, await registeredToolNames());
});

test("the agent-first workflow doc lists every tool the MCP server registers, and no others", async () => {
  const doc = await readFile(workflowDocUrl, "utf8");
  const documented = toolNamesIn(
    listAfterMarker(doc, WORKFLOW_DOC_MARKER, "docs/agent-first-calavera-workflow.md"),
  );

  assert.deepEqual(documented, await registeredToolNames());
});

test("--help lists every tool the MCP server registers, and no others", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"], {
    env: { ...process.env, NO_COLOR: "1" },
  });
  const documented = toolNamesIn(listAfterMarker(stdout, HELP_MARKER, "--help output"));

  assert.deepEqual(documented, await registeredToolNames());
});

test("the list parser catches a missing, an extra, and a repeated tool name", () => {
  const registered = ["apply_recipe", "inspect_project"];

  assert.notDeepEqual(toolNamesIn("`inspect_project`."), registered);
  assert.notDeepEqual(
    toolNamesIn("`inspect_project`, `apply_recipe`, and `drop_table`."),
    registered,
  );
  assert.notDeepEqual(
    toolNamesIn("`inspect_project`, `apply_recipe`, and `apply_recipe`."),
    registered,
  );
  assert.deepEqual(
    toolNamesIn(
      listAfterMarker(
        `${HELP_MARKER}\n     inspect_project,\n     apply_recipe.\n\nPackage-runner syntax:\n  run_this_not`,
        HELP_MARKER,
        "fixture",
      ),
    ),
    registered,
  );
});
