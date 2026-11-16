// Tests for issue #663: with CALAVERA_DEBUG set, the CLI and the MCP server add the stack of
// each error in the chain, redacted like the rest of the chain; without it, nothing changes.
// The chain format and the redaction rules themselves are tested in error-chain.test.mjs and
// redact.test.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toolErrorResult } from "../src/mcp.js";
import { errorChain, formatErrorChain, isDebugEnabled } from "../src/utils/error-chain.js";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Fake secrets in shapes the redaction step recognizes. None is a real credential.
const githubToken = `ghp_${"Z9y8X7w6V5".repeat(4).slice(0, 36)}`;
const envSecret = "s3cr3t-value-from-the-environment";

/** @param {string} text */
function assertNoSecret(text) {
  for (const secret of [githubToken, envSecret]) {
    assert.ok(!text.includes(secret), `a secret was shown: ${secret}\n${text}`);
  }
}

/**
 * An error whose stack is fixed, so the expected output does not depend on where the test runs.
 *
 * @param {string} message
 * @param {string[]} frames
 * @param {ErrorOptions} [options]
 */
function errorWithFrames(message, frames, options) {
  const error = new Error(message, options);
  error.stack = [`Error: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join("\n");
  return error;
}

test("CALAVERA_DEBUG turns on with 1 or true, in any case, and stays off otherwise", () => {
  for (const value of ["1", "true", "TRUE", "True"]) {
    assert.equal(isDebugEnabled({ CALAVERA_DEBUG: value }), true, value);
  }
  for (const value of [undefined, "", "0", "false", "no", "yes", " 1", "10", "truest"]) {
    assert.equal(isDebugEnabled({ CALAVERA_DEBUG: value }), false, String(value));
  }
});

test("without CALAVERA_DEBUG, the chain carries no stack", () => {
  const error = errorWithFrames("outer", ["outer (file:///a.js:1:1)"], {
    cause: errorWithFrames("inner", ["inner (file:///b.js:2:2)"]),
  });

  for (const env of [{}, { CALAVERA_DEBUG: "0" }]) {
    assert.deepEqual(errorChain(error, env), [
      { name: "Error", message: "outer" },
      { name: "Error", message: "inner" },
    ]);
    assert.equal(formatErrorChain(error, env), "outer\nCaused by: inner");
  }
});

test("with CALAVERA_DEBUG, each error in the chain carries its own stack frames", () => {
  const error = errorWithFrames("outer", ["wrap (file:///a.js:1:1)", "main (file:///a.js:9:9)"], {
    cause: errorWithFrames("inner", ["read (file:///b.js:2:2)"], { cause: "a plain string" }),
  });

  assert.deepEqual(errorChain(error, { CALAVERA_DEBUG: "1" }), [
    {
      name: "Error",
      message: "outer",
      stack: "    at wrap (file:///a.js:1:1)\n    at main (file:///a.js:9:9)",
    },
    { name: "Error", message: "inner", stack: "    at read (file:///b.js:2:2)" },
    // A string has no stack, so it carries none.
    { message: "a plain string" },
  ]);
  assert.equal(
    formatErrorChain(error, { CALAVERA_DEBUG: "1" }),
    [
      "outer",
      "    at wrap (file:///a.js:1:1)",
      "    at main (file:///a.js:9:9)",
      "Caused by: inner",
      "      at read (file:///b.js:2:2)",
      "Caused by: a plain string",
    ].join("\n"),
  );
});

test("with CALAVERA_DEBUG, a stack is redacted and has its terminal control sequences removed", () => {
  const error = errorWithFrames("Could not fetch.", [
    `fetch (file:///home/dev/${githubToken}/a.js:1:1)`,
    `run (file:///${envSecret}/b.js:2:2) \u001b[31mred\u001b[39m`,
  ]);

  const env = { CALAVERA_DEBUG: "true", NODE_AUTH_TOKEN: envSecret };
  const [entry] = errorChain(error, env);

  assertNoSecret(JSON.stringify(entry));
  assertNoSecret(formatErrorChain(error, env));
  assert.equal(
    entry.stack,
    "    at fetch (file:///home/dev/[redacted]/a.js:1:1)\n    at run (file:///[redacted]/b.js:2:2) red",
  );
});

test("with CALAVERA_DEBUG, a secret value that spans lines of a stack is redacted whole", () => {
  const privateKey = "line-one-of-the-key\nline-two-of-the-key";
  const error = new Error("Could not sign.");
  error.stack = `Error: Could not sign.\n    at sign (${privateKey})\n    at main (file:///a.js:1:1)`;

  const [entry] = errorChain(error, { CALAVERA_DEBUG: "1", SIGNING_PRIVATE_KEY: privateKey });

  assert.ok(!entry.stack?.includes("line-one-of-the-key"), entry.stack);
  assert.ok(!entry.stack?.includes("line-two-of-the-key"), entry.stack);
  assert.equal(entry.stack, "    at sign ([redacted])\n    at main (file:///a.js:1:1)");
});

test("with CALAVERA_DEBUG, a multi-line message is not repeated as stack frames", () => {
  const error = new TypeError("first line\n    at looks like a frame\nlast line");

  const [entry] = errorChain(error, { CALAVERA_DEBUG: "1" });

  assert.equal(entry.message, "first line\n    at looks like a frame\nlast line");
  assert.ok(entry.stack, "a real error has a stack");
  assert.doesNotMatch(entry.stack, /first line|looks like a frame|last line/);
  assert.match(entry.stack, /^ {4}at .*error-debug\.test\.mjs/);
});

test("with CALAVERA_DEBUG, frames are only lines that start with at, even when the header cannot be found", () => {
  // The stack was read, which makes V8 write the header, before the message changed, so the
  // header is found by its shape alone.
  // The new message is 14 characters long, so cutting the stack at that offset would start in
  // the middle of the header, at " at step 3".
  const renamed = errorWithFrames("failed at step 3", ["run (file:///a.js:1:1)"]);
  renamed.message = "a new message!";

  // A message that is not a string cannot locate the header, even where its string form
  // occurs in a frame.
  const numbered = new Error("x");
  numbered.stack = "Error: x\n    at a404 (file:///a.js:1:1)\n    at b (file:///b.js:2:2)";
  Object.defineProperty(numbered, "message", { value: 404 });

  const env = { CALAVERA_DEBUG: "1" };
  assert.equal(errorChain(renamed, env)[0].stack, "    at run (file:///a.js:1:1)");
  assert.equal(
    errorChain(numbered, env)[0].stack,
    "    at a404 (file:///a.js:1:1)\n    at b (file:///b.js:2:2)",
  );
});

test("with CALAVERA_DEBUG, a cause whose text repeats its wrapper is kept for its stack alone", () => {
  const cause = errorWithFrames("disk full", ["write (file:///b.js:2:2)"]);
  const error = errorWithFrames("Could not save: disk full", ["save (file:///a.js:1:1)"], {
    cause,
  });

  // Without the switch, the repeated cause is left out, as before.
  assert.equal(errorChain(error, {}).length, 1);
  assert.deepEqual(errorChain(error, { CALAVERA_DEBUG: "1" }), [
    {
      name: "Error",
      message: "Could not save: disk full",
      stack: "    at save (file:///a.js:1:1)",
    },
    { name: "Error", message: "", stack: "    at write (file:///b.js:2:2)" },
  ]);
  assert.equal(
    formatErrorChain(error, { CALAVERA_DEBUG: "1" }),
    [
      "Could not save: disk full",
      "    at save (file:///a.js:1:1)",
      "Caused by: Error",
      "      at write (file:///b.js:2:2)",
    ].join("\n"),
  );
});

test("with CALAVERA_DEBUG, distinct failures with the same message stay distinguishable by stack", () => {
  const fromRegistry = errorWithFrames(`401 for ${githubToken}`, [
    "fetchPackument (file:///r.js:1:1)",
  ]);
  const fromGit = errorWithFrames(`401 for ${githubToken}`, ["pushBranch (file:///g.js:1:1)"]);

  const env = { CALAVERA_DEBUG: "1" };
  const registryText = formatErrorChain(fromRegistry, env);
  const gitText = formatErrorChain(fromGit, env);

  assertNoSecret(registryText + gitText);
  assert.equal(formatErrorChain(fromRegistry, {}), formatErrorChain(fromGit, {}));
  assert.notEqual(registryText, gitText);
});

test("an MCP tool error carries each stack only with CALAVERA_DEBUG", () => {
  const error = errorWithFrames(
    "Could not install the artifacts.",
    ["install (file:///a.js:1:1)"],
    {
      cause: errorWithFrames(`GET 401 as ${envSecret}`, [`get (file:///${envSecret}.js:2:2)`]),
    },
  );

  const off = JSON.parse(toolErrorResult(error, { NODE_AUTH_TOKEN: envSecret }).content[0].text);
  const onText = toolErrorResult(error, { NODE_AUTH_TOKEN: envSecret, CALAVERA_DEBUG: "1" })
    .content[0].text;

  assert.deepEqual(off, {
    error: {
      name: "Error",
      message: "Could not install the artifacts.",
      causes: [{ name: "Error", message: "GET 401 as [redacted]" }],
    },
  });
  assertNoSecret(onText);
  assert.deepEqual(JSON.parse(onText), {
    error: {
      name: "Error",
      message: "Could not install the artifacts.",
      stack: "    at install (file:///a.js:1:1)",
      causes: [
        {
          name: "Error",
          message: "GET 401 as [redacted]",
          stack: "    at get (file:///[redacted].js:2:2)",
        },
      ],
    },
  });
});

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string>} extraEnv
 * @returns {Promise<{ code: number, stderr: string }>}
 */
function runCli(args, cwd, extraEnv) {
  const env = { ...process.env, NO_COLOR: "1", ...extraEnv };
  if (!("CALAVERA_DEBUG" in extraEnv)) delete env.CALAVERA_DEBUG;

  return new Promise((resolvePromise) => {
    execFile(process.execPath, [cliPath, ...args], { cwd, env }, (error, _stdout, stderr) => {
      resolvePromise({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stderr,
      });
    });
  });
}

const FRAME_LINE = /^\s+at /;

/**
 * The CLI's error text without what the debug switch adds: the stack frame lines, and each
 * "Caused by:" line that has only a name and is followed by frames, which is a cause kept
 * only for its stack.
 *
 * @param {string} text
 */
function withoutDebugLines(text) {
  const lines = text.split("\n");
  return lines
    .filter(
      (line, index) =>
        !FRAME_LINE.test(line) &&
        !(/^Caused by: \S+$/.test(line) && FRAME_LINE.test(lines[index + 1] ?? "")),
    )
    .join("\n");
}

test("withoutDebugLines removes frames and the causes kept only for their stack", () => {
  const on = [
    "Could not save: disk full",
    "    at save (file:///a.js:1:1)",
    "Caused by: Error",
    "      at write (file:///b.js:2:2)",
    "Caused by: EACCES",
    "Caused by: permission denied",
    "      at open (file:///c.js:3:3)",
    "",
  ].join("\n");

  assert.equal(
    withoutDebugLines(on),
    "Could not save: disk full\nCaused by: EACCES\nCaused by: permission denied\n",
  );
});

test("the CLI prints redacted stacks for its top-level error only with CALAVERA_DEBUG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-error-debug-cli-"));

  try {
    // The config path holds a secret-shaped segment, which the ENOENT message shows. The file
    // system error carries no frames of its own, so this test shows that the CLI honors the
    // switch and that redaction still applies; the unit tests above cover secrets in a stack.
    const missing = join(directory, githubToken, "missing.json");
    const args = ["--yes", "--config", missing, "--new", "vite"];

    const off = await runCli(args, directory, {});
    const on = await runCli(args, directory, { CALAVERA_DEBUG: "1" });

    assert.equal(off.code, 1);
    assert.equal(on.code, 1);
    assert.doesNotMatch(off.stderr, /\n\s+at /);
    assertNoSecret(off.stderr);
    assertNoSecret(on.stderr);
    assert.match(on.stderr, /--new refused/);
    assert.match(on.stderr, /\n {4}at .*index\.js:\d+:\d+/);
    // The output without the switch is the output with it, minus the stack frames and minus
    // each cause that the switch keeps only for its stack. Whether the ENOENT cause has frames
    // depends on the Node.js version: on Node.js 24 it does, so it is kept as "Caused by: Error"
    // followed by its frames; on Node.js 26 it has none, so it is left out as before.
    assert.equal(withoutDebugLines(on.stderr), off.stderr);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
