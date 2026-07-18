import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageJson from "../package.json" with { type: "json" };
import { runMcpEntrypoint } from "../src/mcp.js";

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

test("MCP entrypoint logs startup failures to stderr without writing stdout", async () => {
  const stdoutWrites = [];
  const stderrWrites = [];
  const exitCodes = [];
  const originalStdoutWrite = process.stdout.write;

  try {
    process.stdout.write = function captureStdoutWrite(chunk, ...args) {
      stdoutWrites.push(String(chunk));
      return originalStdoutWrite.call(this, chunk, ...args);
    };

    await runMcpEntrypoint({
      cwd: "/example/project",
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        },
      },
      setExitCode(code) {
        exitCodes.push(code);
      },
      async startServer() {
        throw new Error("transport failed before initialization");
      },
    });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const stderr = stderrWrites.join("");

  assert.deepEqual(exitCodes, [1]);
  assert.equal(stdoutWrites.join(""), "");
  assert.match(stderr, /create-project-calavera/);
  assert.ok(stderr.includes(`v${packageJson.version}`));
  assert.match(stderr, /mode=stdio/);
  assert.match(stderr, /cwd=\/example\/project/);
  assert.match(stderr, /failed to start MCP server/);
  assert.match(stderr, /transport failed before initialization/);
});
