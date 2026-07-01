import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server starts when launched through a bin symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-mcp-entrypoint-"));
  const symlinkPath = join(directory, "create-project-calavera-mcp");
  const mcpPath = fileURLToPath(new URL("../src/mcp.js", import.meta.url));
  await symlink(mcpPath, symlinkPath);

  const client = new Client({
    name: "calavera-entrypoint-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [symlinkPath],
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();

    assert.ok(tools.some(({ name }) => name === "compose_recipe"));
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
