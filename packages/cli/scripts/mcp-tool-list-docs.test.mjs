// #839: the README and `--help` tell people which MCP tools to confirm before composing a
// recipe, and permission allow-lists are built from that list, so a tool the documents leave
// out gets denied. These tests compare both lists with the tools the server registers.
// #933: the README's tool-order list and the bundled Calavera skill, which tells an agent which
// tools to look for, are checked the same way. The generated `.agents/calavera/mcp.md` list is
// not checked here yet: changing its text waits for #934.
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
// The CLI installs the first copy during `--init`; the second is the published skill artifact.
const skills = [
  {
    source: "packages/cli/src/bootstrap/calavera/SKILL.md",
    url: new URL("../src/bootstrap/calavera/SKILL.md", import.meta.url),
  },
  {
    source: "packages/artifacts/skill-calavera/payload/calavera/SKILL.md",
    url: new URL("../../artifacts/skill-calavera/payload/calavera/SKILL.md", import.meta.url),
  },
];

const README_MARKER = "Confirm the Calavera MCP tools are exposed:";
const WORKFLOW_DOC_MARKER = "Calavera MCP tools are exposed:";
const HELP_MARKER = "Confirm these tools are visible before composing a recipe:";
const README_ORDER_MARKER = "in this order:";
const SKILL_MARKER = "Look for tools named";
const WORKFLOW_DOC_MCP_MARKER = "project-local\napply tools:";
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
 * The numbered list that follows the marker, one item per line, so the parse stops at the first
 * line after the list that is not a numbered item.
 *
 * @param {string} text
 * @param {string} marker
 * @param {string} source
 * @returns {string}
 */
function numberedListAfterMarker(text, marker, source) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `${source} no longer contains "${marker}"`);
  assert.equal(
    text.indexOf(marker, start + marker.length),
    -1,
    `${source} contains "${marker}" more than once`,
  );
  const lines = text
    .slice(start + marker.length)
    .replace(/^\s*\n/, "")
    .split("\n");
  const end = lines.findIndex((line) => !/^\d+\.\s/.test(line));
  const items = end === -1 ? lines : lines.slice(0, end);
  assert.notEqual(items.length, 0, `${source} has no numbered list after "${marker}"`);
  return items.join("\n");
}

/**
 * The tool names in a list, sorted, so the tests compare which tools a list names and not their
 * order. The registration order cannot be the reference, because the server registers
 * `list_profiles` before `inspect_project`, while the documented workflows start with
 * `inspect_project`.
 *
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

test("the README's tool-order list names every tool the MCP server registers, and no others", async () => {
  const readme = await readFile(readmeUrl, "utf8");
  const documented = toolNamesIn(numberedListAfterMarker(readme, README_ORDER_MARKER, "README.md"));

  assert.deepEqual(documented, await registeredToolNames());
});

for (const { source, url } of skills) {
  test(`the bundled Calavera skill at ${source} lists every tool the MCP server registers, and no others`, async () => {
    const skill = await readFile(url, "utf8");
    const documented = toolNamesIn(listAfterMarker(skill, SKILL_MARKER, source));

    assert.deepEqual(documented, await registeredToolNames());
  });
}

test("the agent-first workflow doc lists every tool the MCP server registers, and no others", async () => {
  const doc = await readFile(workflowDocUrl, "utf8");
  const documented = toolNamesIn(
    listAfterMarker(doc, WORKFLOW_DOC_MARKER, "docs/agent-first-calavera-workflow.md"),
  );

  assert.deepEqual(documented, await registeredToolNames());
});

test("the agent-first workflow doc's standard MCP list names every tool the MCP server registers, and no others", async () => {
  const doc = await readFile(workflowDocUrl, "utf8");
  const documented = toolNamesIn(
    numberedListAfterMarker(doc, WORKFLOW_DOC_MCP_MARKER, "docs/agent-first-calavera-workflow.md"),
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

test("the numbered-list parser stops at the first line that is not a numbered item", () => {
  const fixture = `${README_ORDER_MARKER}\n\n1. \`inspect_project\`\n2. \`apply_recipe\`\n\n\`dry_run_apply\` returns structured JSON.`;

  assert.deepEqual(toolNamesIn(numberedListAfterMarker(fixture, README_ORDER_MARKER, "fixture")), [
    "apply_recipe",
    "inspect_project",
  ]);
  assert.throws(
    () =>
      numberedListAfterMarker(
        `${README_ORDER_MARKER}\n\nNo list here.`,
        README_ORDER_MARKER,
        "fixture",
      ),
    /has no numbered list/,
  );
});
