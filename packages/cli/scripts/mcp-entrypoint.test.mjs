import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageJson from "../package.json" with { type: "json" };
import { runMcpEntrypoint } from "../src/mcp.js";
import { formatErrorChain } from "../src/utils/error-chain.js";

const execFileAsync = promisify(execFile);

const mcpEntries = {
  "the bin": fileURLToPath(new URL("../bin/create-project-calavera-mcp.js", import.meta.url)),
  "src/mcp.js": fileURLToPath(new URL("../src/mcp.js", import.meta.url)),
};

for (const [entry, mcpPath] of Object.entries(mcpEntries)) {
  test(`MCP server starts when ${entry} is launched through a symlink`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "calavera-mcp-entrypoint-"));
    const symlinkPath = join(directory, "create-project-calavera-mcp");
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
}

for (const [description, extraArgs] of [
  ["there is no entry script", []],
  ["the entry script does not exist", ["/nonexistent/create-project-calavera-mcp"]],
]) {
  test(`importing src/mcp.js does not start the server when ${description}`, async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(mcpEntries["src/mcp.js"]).href)});`,
        ...extraArgs,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );

    assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /starting MCP server/u);
  });
}

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

/**
 * Runs the MCP entrypoint with a server that fails to start with `error`, and
 * returns what it wrote to stderr.
 *
 * @param {unknown} error
 * @param {Record<string, string | undefined>} env
 */
async function startupFailureStderr(error, env) {
  const stderrWrites = [];

  await runMcpEntrypoint({
    cwd: "/example/project",
    env,
    stderr: {
      write(chunk) {
        stderrWrites.push(String(chunk));
        return true;
      },
    },
    setExitCode() {},
    async startServer() {
      throw error;
    },
  });

  return stderrWrites.join("");
}

// The value is long enough to be redacted by value, and its shape matches no
// secret pattern, so only the environment can redact it.
const envSecret = "startup-cause-value-4f9c2a71";

function wrappedStartupError() {
  return new Error("Could not open the MCP transport.", {
    cause: new Error(`stdio pipe refused the handshake for ${envSecret}`, {
      cause: new TypeError("stream is not writable"),
    }),
  });
}

test("MCP startup failure prints each error in its cause chain, redacted", async () => {
  const env = { NPM_TOKEN: envSecret };
  const stderr = await startupFailureStderr(wrappedStartupError(), env);

  assert.ok(!stderr.includes(envSecret), "the secret in a cause's message is redacted");
  assert.ok(
    stderr.endsWith(
      [
        "failed to start MCP server",
        "Could not open the MCP transport.",
        "Caused by: stdio pipe refused the handshake for [redacted]",
        "Caused by: TypeError: stream is not writable",
        "",
      ].join("\n"),
    ),
    stderr,
  );
  assert.doesNotMatch(stderr, /^\s+at\s/mu, "no stack frames without CALAVERA_DEBUG");
});

test("MCP startup failure prints the stack frames of each error with CALAVERA_DEBUG", async () => {
  const env = { NPM_TOKEN: envSecret, CALAVERA_DEBUG: "1" };
  const error = wrappedStartupError();
  const stderr = await startupFailureStderr(error, env);
  const formatted = formatErrorChain(error, env);

  assert.ok(!stderr.includes(envSecret), "the secret in a cause's message is redacted");
  assert.ok(stderr.endsWith(`failed to start MCP server\n${formatted}\n`), stderr);
  assert.equal(stderr.match(/^Caused by: /gmu)?.length, 2);
  // The wrapper's frames, then each cause's frames, indented under it.
  assert.match(stderr, /\nCould not open the MCP transport\.\n\s+at\s/u);
  assert.match(stderr, /\nCaused by: stdio pipe refused the handshake for \[redacted\]\n\s+at\s/u);
  assert.match(stderr, /\nCaused by: TypeError: stream is not writable\n\s+at\s/u);
});

test("MCP startup failure still prints the error, redacted, when the chain cannot be formatted", async () => {
  // A chain this deep overflows the call stack of the recursive chain walk.
  let error = new Error("innermost cause");
  for (let depth = 0; depth < 20_000; depth += 1) {
    error = new Error(`level ${depth}`, { cause: error });
  }
  error.message = `transport failed for ${envSecret}`;

  const exitCodes = [];
  const stderrWrites = [];
  await runMcpEntrypoint({
    cwd: "/example/project",
    env: { NPM_TOKEN: envSecret },
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
      throw error;
    },
  });
  const stderr = stderrWrites.join("");

  assert.deepEqual(exitCodes, [1]);
  assert.ok(
    stderr.endsWith("failed to start MCP server\ntransport failed for [redacted]\n"),
    stderr,
  );
});
