// Tests for issue #619: the CLI and the MCP server show an error's cause chain
// once, with secrets redacted, and distinct failures stay distinguishable.
// The redaction patterns themselves are tested in redact.test.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { execa } from "execa";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { describeCommandFailure } from "../src/index.js";
import { createMcpServer, runMcpEntrypoint, toolErrorResult } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { errorChain, formatErrorChain } from "../src/utils/error-chain.js";
import { json, libraryManifest, vitePlusConfig } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const artifactPackagesRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));

// Fake secrets in the shapes the redaction step recognizes. None is a real credential.
const npmToken = `npm_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
const githubToken = `ghp_${"Z9y8X7w6V5".repeat(4).slice(0, 36)}`;
const envSecret = "s3cr3t-value-from-the-environment";
const secrets = [npmToken, githubToken, envSecret];

/** @param {string} text */
function assertNoSecret(text) {
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `a secret was shown: ${secret}\n${text}`);
  }
}

/**
 * @param {string} text
 * @param {string} fragment
 */
function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

test("a child-process cause shows its redacted command and exit code, not its output again", async () => {
  const outputLines = Array.from(
    { length: 40 },
    (_, index) => `output line ${String(index + 1).padStart(2, "0")}`,
  );
  // The child runs a script file, not an inline -e script, so that the command line stays
  // under FAILURE_OUTPUT_LINE_LENGTH even where process.execPath is a long path, as on CI.
  const directory = await mkdtemp(join(tmpdir(), "calavera-error-chain-child-"));
  let childError;
  try {
    await writeFile(
      join(directory, "fail.mjs"),
      `for (let line = 1; line <= 40; line++) console.log("output line " + String(line).padStart(2, "0"));\nconsole.error("${githubToken}");\nprocess.exit(3);\n`,
    );
    childError = await execa(process.execPath, ["fail.mjs", `--token=${npmToken}`], {
      cwd: directory,
      env: { NPM_TOKEN: envSecret },
      reject: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(childError.exitCode, 3);
  // The wrapper the CLI throws when an install fails.
  const wrapper = new Error(
    [
      "Calavera could not install the development dependencies.",
      describeCommandFailure(childError),
    ].join("\n"),
    { cause: childError },
  );

  const text = formatErrorChain(wrapper, { NPM_TOKEN: envSecret });

  assertNoSecret(text);
  assert.match(
    text,
    /^Caused by: ExecaError: Command failed with exit code 3: .*'--token=\[redacted\]'$/m,
  );
  for (const line of outputLines.slice(0, 30)) {
    assert.equal(occurrences(text, line), 0, `${line} was shown\n${text}`);
  }
  for (const line of outputLines.slice(30)) {
    assert.equal(occurrences(text, line), 1, `${line} was not shown once\n${text}`);
  }
});

test("a cause is shown once: an embedded cause is not repeated, a deferred cause is shown", () => {
  const readError = Object.assign(new Error("ENOENT: no such file or directory, open 'a.json'"), {
    code: "ENOENT",
  });
  // The wrapper embeds the cause message, as most Calavera wrappers do.
  const embedded = new Error(
    `--new refused: the recipe could not be read: ${readError.message}. Nothing was run.`,
    { cause: readError },
  );
  // The wrapper defers to its cause.
  const deferred = new Error("package.json could not be read", { cause: readError });
  // The wrapper embeds the cause with its final period removed.
  const validation = new Error("Invalid profile: x. Allowed values: default, minimal.");
  const trimmed = new Error(
    `--new refused: a.json is not a valid recipe: ${validation.message.replace(/\.$/, "")}. Nothing was run.`,
    { cause: validation },
  );

  const embeddedText = formatErrorChain(embedded, {});
  assert.equal(occurrences(embeddedText, readError.message), 1, embeddedText);
  assert.doesNotMatch(embeddedText, /Caused by/);

  assert.equal(
    formatErrorChain(deferred, {}),
    `package.json could not be read\nCaused by: ${readError.message}`,
  );
  assert.deepEqual(errorChain(deferred, {}), [
    { name: "Error", message: "package.json could not be read" },
    { name: "Error", message: readError.message, code: "ENOENT" },
  ]);

  assert.doesNotMatch(formatErrorChain(trimmed, {}), /Caused by/);
});

test("a cause is left out whole only when its whole message occurs in an earlier one", () => {
  // "line 3" occurs in "line 31" only as part of a longer word.
  assert.equal(
    formatErrorChain(new Error("output: line 31", { cause: new Error("line 3") }), {}),
    "output: line 31\nCaused by: line 3",
  );
  // A one-word cause is shown even when the word occurs in the message.
  assert.equal(
    formatErrorChain(new Error("Run npm install first.", { cause: new Error("install") }), {}),
    "Run npm install first.\nCaused by: install",
  );
  // A line of a cause is left out only when it equals a line already shown.
  assert.equal(
    formatErrorChain(
      new Error("Could not fetch.\nline 31", {
        cause: new Error("request failed\nline 3\nline 31"),
      }),
      {},
    ),
    "Could not fetch.\nline 31\nCaused by: request failed\n  line 3",
  );
});

test("a cause chain shows only the lines a wrapper did not already show, through every level", () => {
  const root = new Error("connect ECONNREFUSED 127.0.0.1:4873");
  const middle = new Error(`registry request failed\n${root.message}`, { cause: root });
  const top = new Error("Could not install the artifacts.", { cause: middle });
  const aggregate = new AggregateError(
    [top, new Error("EACCES: permission denied, rmdir '.calavera'")],
    `Install failed, and the rollback also failed. ${top.message}`,
    { cause: top },
  );

  const text = formatErrorChain(aggregate, {});

  assert.equal(
    text,
    [
      "AggregateError: Install failed, and the rollback also failed. Could not install the artifacts.",
      "Caused by: registry request failed",
      "  connect ECONNREFUSED 127.0.0.1:4873",
      "Caused by: EACCES: permission denied, rmdir '.calavera'",
    ].join("\n"),
  );
  assert.equal(occurrences(text, "ECONNREFUSED"), 1);
});

test("sibling AggregateError members are each shown once", () => {
  const aggregate = new AggregateError(
    [
      new Error("registry timed out after 30 s"),
      new Error("registry timed out after 30 s"),
      new Error("first install\nshared line"),
      new Error("second install\nshared line"),
    ],
    "Two installs failed.",
  );

  assert.equal(
    formatErrorChain(aggregate, {}),
    [
      "AggregateError: Two installs failed.",
      "Caused by: registry timed out after 30 s",
      "Caused by: first install",
      "  shared line",
      "Caused by: second install",
    ].join("\n"),
  );
});

test("an error name other than Error prefixes its message, and stands in for an empty one", () => {
  const error = new TypeError("options.recipe is not a function", {
    cause: new RangeError("", { cause: new Error("") }),
  });

  assert.equal(
    formatErrorChain(error, {}),
    "TypeError: options.recipe is not a function\nCaused by: RangeError\nCaused by: Error",
  );
  assert.equal(formatErrorChain(new Error(""), {}), "Error");
});

test("a cause chain survives a cycle, a revoked proxy, and causes that are not errors", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  const withoutPrototype = Object.create(null);
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  assert.equal(formatErrorChain(first, {}), "first\nCaused by: second");
  assert.equal(
    formatErrorChain(new Error("outer", { cause: "a plain string cause" }), {}),
    "outer\nCaused by: a plain string cause",
  );
  assert.equal(formatErrorChain("thrown string", {}), "thrown string");
  assert.equal(
    formatErrorChain(new Error("outer", { cause: withoutPrototype }), {}),
    "outer\nCaused by: [object Object]",
  );
  assert.equal(
    formatErrorChain(new Error("outer", { cause: { message: 404, code: "E404" } }), {}),
    "outer\nCaused by: 404",
  );
  assert.deepEqual(errorChain(new Error("outer", { cause: { message: 404, code: "E404" } }), {}), [
    { name: "Error", message: "outer" },
    { message: "404", code: "E404" },
  ]);
  assert.equal(
    formatErrorChain(new Error("outer", { cause: proxy }), {}),
    "outer\nCaused by: [a value that cannot be displayed]",
  );
});

test("a cause's name and code are redacted too", () => {
  const cause = Object.assign(new Error("request failed"), {
    name: `HttpError ${npmToken}`,
    code: `E401 ${githubToken}`,
  });

  const chain = errorChain(new Error("Could not fetch.", { cause }), {});

  assertNoSecret(JSON.stringify(chain));
  assert.deepEqual(chain[1], {
    name: "HttpError [redacted]",
    message: "request failed",
    code: "E401 [redacted]",
  });
});

test("a cause is cut at ten lines of at most 300 characters each", () => {
  const lines = Array.from({ length: 14 }, (_, index) => `cause line ${index + 1}`);
  lines[0] = "x".repeat(400);

  const [, cause] = errorChain(new Error("Wrapper.", { cause: new Error(lines.join("\n")) }), {});

  assert.deepEqual(cause.message.split("\n"), [
    `${"x".repeat(300)}… [line truncated]`,
    ...lines.slice(1, 10),
    "… 4 more lines",
  ]);
});

/**
 * @param {string} id
 */
function artifactFixturePayloadPath(id) {
  const artifact = artifactForId(id);
  assert.ok(artifact, `Unknown artifact fixture: ${id}`);
  return join(artifactPackagesRoot, id, artifact.payload);
}

/**
 * Runs `artifacts install` for skill-project-goal in a new temporary project
 * and returns the error it rejects with.
 *
 * @param {{ resolve?: () => Promise<never>, conflict?: boolean }} options
 */
async function artifactInstallFailure({ resolve, conflict = false }) {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-error-chain-"));
  const registry = {
    resolve:
      resolve ??
      (async (request) => {
        const artifact = artifactForId(request.id);
        return {
          artifact,
          packageName: artifact.packageName,
          version: "0.1.0",
          resolved: `https://registry.example/${request.id}-0.1.0.tgz`,
          integrity: `sha512-${"a".repeat(86)}==`,
          tag: request.tag ?? "latest",
          cache: request.cache,
          offline: false,
        };
      }),
    extract: async (resolution, destination) => {
      const payload = "payload/project-goal";
      const payloadPath = join(destination, payload);
      await mkdir(dirname(payloadPath), { recursive: true });
      await cp(artifactFixturePayloadPath(resolution.artifact.id), payloadPath, {
        recursive: true,
      });
      return { manifest: { type: "skill", payload }, payloadPath, payloadHash: "b".repeat(64) };
    },
  };

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "calavera.config.json",
      json({ ...buildRecipe("minimal", [], "npm", [], {}), ai: [{ id: "skill-project-goal" }] }),
    );
    if (conflict) {
      await mkdir(".agents/skills/project-goal", { recursive: true });
      await writeFile(".agents/skills/project-goal/SKILL.md", "a local skill\n");
    }
    try {
      await runArtifactCommand(
        { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
        registry,
      );
    } catch (error) {
      return error;
    }
    assert.fail("artifacts install did not fail");
  } finally {
    process.chdir(originalDirectory);
    await rm(projectDirectory, { force: true, recursive: true });
  }
}

test("a registry failure and a file conflict stay distinguishable after wrapping and redaction", async () => {
  const registryFailure = await artifactInstallFailure({
    resolve: async () => {
      throw Object.assign(
        new Error(
          `401 Unauthorized - GET https://registry.npmjs.org/@schalkneethling%2fcalavera-skill-project-goal - authorization: Bearer ${npmToken}`,
        ),
        { code: "E401" },
      );
    },
  });
  const fileConflict = await artifactInstallFailure({ conflict: true });

  const registryText = formatErrorChain(registryFailure, {});
  const conflictText = formatErrorChain(fileConflict, {});
  const registryChain = errorChain(registryFailure, {});
  const conflictChain = errorChain(fileConflict, {});

  assertNoSecret(registryText);
  assertNoSecret(JSON.stringify(registryChain));
  assert.notEqual(registryText, conflictText);
  assert.match(registryText, /401 Unauthorized/);
  assert.doesNotMatch(registryText, /Refusing to overwrite/);
  assert.match(
    conflictText,
    /Refusing to overwrite existing AI artifact: \.agents\/skills\/project-goal/,
  );
  assert.doesNotMatch(conflictText, /401 Unauthorized/);
  // The structured chain keeps the registry error's code, which the conflict does not have.
  assert.ok(
    registryChain.some(({ code }) => code === "E401"),
    JSON.stringify(registryChain),
  );
  assert.ok(
    conflictChain.every(({ code }) => code !== "E401"),
    JSON.stringify(conflictChain),
  );
});

test("an MCP tool error carries the redacted cause chain as structured JSON", () => {
  const cause = Object.assign(
    new Error(`GET https://registry.example 401 Bearer ${npmToken} as ${envSecret}`),
    { code: "E401" },
  );
  const result = toolErrorResult(new Error("Could not install the artifacts.", { cause }), {
    NODE_AUTH_TOKEN: envSecret,
  });

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal("structuredContent" in result, false);
  assertNoSecret(result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: {
      name: "Error",
      message: "Could not install the artifacts.",
      causes: [
        {
          name: "Error",
          message: "GET https://registry.example 401 Bearer [redacted] as [redacted]",
          code: "E401",
        },
      ],
    },
  });
});

test("the MCP server redacts a startup error it writes to stderr", async () => {
  /** @type {string[]} */
  const stderrWrites = [];

  await runMcpEntrypoint({
    cwd: "/example/project",
    env: { GH_TOKEN: envSecret },
    stderr: {
      write(chunk) {
        stderrWrites.push(String(chunk));
        return true;
      },
    },
    setExitCode() {},
    async startServer() {
      throw new Error(`transport failed with ${envSecret} and Bearer ${githubToken}`);
    },
  });

  const stderr = stderrWrites.join("");
  assertNoSecret(stderr);
  assert.match(stderr, /transport failed with \[redacted\] and Bearer \[redacted\]/);
});

test("a registered MCP tool that throws answers with an error result, also when it declares an output schema", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-error-chain-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // listTools makes the client validate structuredContent against describe_integration's
    // output schema, so an error result that carried structuredContent would be rejected.
    await client.listTools();
    const result = await client.callTool({
      name: "describe_integration",
      arguments: { id: "no-such-integration" },
    });

    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      error: { name: "Error", message: "Unknown integration: no-such-integration.", causes: [] },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

test("the CLI prints an embedded cause once and a deferred cause after the message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-error-chain-cli-"));

  try {
    const missing = join(directory, "missing.json");
    const embedded = await runCli(["--yes", "--config", missing, "--new", "vite"], directory);

    assert.equal(embedded.code, 1);
    assert.match(embedded.stderr, /--new refused/);
    assert.equal(occurrences(embedded.stderr, "ENOENT"), 1, embedded.stderr);
    assert.doesNotMatch(embedded.stderr, /Caused by|\n\s+at /);

    // A Vite+-managed project without vite-plus installed: the wrapper says so in its own
    // words and defers to the module resolution error as its cause.
    const recipeSource = json(buildRecipe("minimal", ["knip"], "npm", [], {}));
    await mkdir(join(directory, ".git"));
    await writeFile(join(directory, "package.json"), json(libraryManifest));
    await writeFile(join(directory, "vite.config.ts"), vitePlusConfig);
    await writeFile(join(directory, "calavera.config.json"), recipeSource);

    const deferred = await runCli(["apply", "--yes"], directory);

    assert.equal(deferred.code, 1, deferred.stdout);
    assert.equal(occurrences(deferred.stderr, "vite-plus is not installed"), 1, deferred.stderr);
    assert.match(deferred.stderr, /^Caused by: Cannot find module 'vite-plus\/package\.json'/m);
    assert.equal(occurrences(deferred.stderr, "Caused by:"), 1, deferred.stderr);
    assert.doesNotMatch(deferred.stderr, /\n\s+at /);

    // An installed vite-plus with an unparseable manifest: each of three wrappers embeds the
    // message under it, so the chain adds nothing.
    await mkdir(join(directory, "node_modules/vite-plus"), { recursive: true });
    await writeFile(join(directory, "node_modules/vite-plus/package.json"), "{ not json");
    const nested = await runCli(["apply", "--yes"], directory);

    assert.equal(nested.code, 1, nested.stdout);
    assert.match(nested.stderr, /vite-plus could not be resolved from/);
    assert.equal(occurrences(nested.stderr, "Invalid package config"), 1, nested.stderr);
    assert.doesNotMatch(nested.stderr, /Caused by/);
    assert.equal(await readFile(join(directory, "calavera.config.json"), "utf8"), recipeSource);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
