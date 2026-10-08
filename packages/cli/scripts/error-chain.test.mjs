// Tests for issue #619: the CLI and the MCP server show an error's cause chain
// once, with secrets redacted, and distinct failures stay distinguishable.
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
import { createMcpServer, toolErrorResult } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { errorChain, formatErrorChain } from "../src/utils/error-chain.js";
import { redactSecrets } from "../src/utils/redact.js";
import { json, libraryManifest, vitePlusConfig } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const artifactPackagesRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));

// Fake secrets in the shapes the redaction step recognizes. None is a real credential.
const npmToken = `npm_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
const githubToken = `ghp_${"Z9y8X7w6V5".repeat(4).slice(0, 36)}`;
const fineGrainedToken = `github_pat_${"11ABCDEFG0".repeat(3)}_${"q".repeat(40)}`;
const envSecret = "s3cr3t-value-from-the-environment";
const secrets = [npmToken, githubToken, fineGrainedToken, envSecret, "hunter2-password"];

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

test("redactSecrets removes tokens, auth headers, URL user information, and secret environment values", () => {
  const env = { NPM_TOKEN: envSecret, HOME: "/home/someone", CI: "true" };
  const text = [
    `npm error 401 Unauthorized ${npmToken}`,
    `remote: Invalid credentials ${githubToken} and ${fineGrainedToken}`,
    `authorization: Bearer ${npmToken}`,
    "Authorization: Basic dXNlcjpodW50ZXIyLXBhc3N3b3Jk",
    "Authorization: token abcdef0123456789",
    "//registry.npmjs.org/:_authToken=abcdef0123456789",
    "//registry.example/:_password=hunter2-password",
    "GET https://someone:hunter2-password@registry.example/pkg",
    `git clone https://x-access-token:${githubToken}@github.com/owner/repo.git`,
    `NODE_AUTH_TOKEN=${envSecret} npm publish`,
    `echo ${envSecret}`,
    "HOME is /home/someone",
  ].join("\n");

  const redacted = redactSecrets(text, env);

  assertNoSecret(redacted);
  assert.doesNotMatch(redacted, /dXNlcjpodW50ZXIy|abcdef0123456789/);
  // What is not secret stays, so the failure is still diagnosable.
  assert.match(redacted, /npm error 401 Unauthorized/);
  assert.match(redacted, /https:\/\/\[redacted\]@registry\.example\/pkg/);
  assert.match(redacted, /github\.com\/owner\/repo\.git/);
  assert.match(redacted, /^HOME is \/home\/someone$/m);
  assert.match(redacted, /_authToken=\[redacted\]/);
  // Redacting again changes nothing.
  assert.equal(redactSecrets(redacted, env), redacted);
});

test("redactSecrets keeps short or non-secret environment values", () => {
  const env = { GITHUB_TOKEN: "", NPM_CONFIG_AUTH: "true", USER: "someone" };

  assert.equal(
    redactSecrets("true: someone ran it", env),
    "true: someone ran it",
    "an empty or short secret value or a variable without a secret name was redacted",
  );
});

test("a child-process cause is shown with its command and output redacted", async () => {
  const childError = await execa(
    process.execPath,
    [
      "-e",
      `console.log("fetching with " + process.env.NPM_TOKEN); console.error("${githubToken}"); process.exit(3)`,
      "--",
      `--token=${npmToken}`,
    ],
    { env: { NPM_TOKEN: envSecret }, reject: false },
  );
  assert.equal(childError.exitCode, 3);
  const wrapper = new Error("Calavera could not install the development dependencies.", {
    cause: childError,
  });

  const text = formatErrorChain(wrapper, { NPM_TOKEN: envSecret });

  assertNoSecret(text);
  assert.match(text, /^Calavera could not install the development dependencies\.$/m);
  assert.match(text, /^Caused by: Command failed with exit code 3: /m);
  assert.match(text, /fetching with \[redacted\]/);
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
      "Install failed, and the rollback also failed. Could not install the artifacts.",
      "Caused by: registry request failed",
      "  connect ECONNREFUSED 127.0.0.1:4873",
      "Caused by: EACCES: permission denied, rmdir '.calavera'",
    ].join("\n"),
  );
  assert.equal(occurrences(text, "ECONNREFUSED"), 1);
});

test("a cause chain survives a cycle and a non-Error cause", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;

  assert.equal(formatErrorChain(first, {}), "first\nCaused by: second");
  assert.equal(
    formatErrorChain(new Error("outer", { cause: "a plain string cause" }), {}),
    "outer\nCaused by: a plain string cause",
  );
  assert.equal(formatErrorChain("thrown string", {}), "thrown string");
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
  const cause = Object.assign(new Error(`GET https://registry.example 401 Bearer ${npmToken}`), {
    code: "E401",
  });
  const result = toolErrorResult(new Error("Could not install the artifacts.", { cause }));

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
          message: "GET https://registry.example 401 Bearer [redacted]",
          code: "E401",
        },
      ],
    },
  });
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
