// ADR-0023: Calavera stops when Yarn 1 starts it. The CLI stops in runCli, right after it parses
// its arguments and before the version check (Decision 1); the MCP server stops in
// runMcpEntrypoint, before it starts. Every test sets both launcher variables, because the test
// runner's own environment carries pnpm's npm_execpath, which would hide the stop (Decision 6).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { unsupportedYarnMessage } from "../src/index.js";
import { runMcpEntrypoint } from "../src/mcp.js";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const YARN_1 = "yarn/1.22.22 npm/? node/v24.3.0 darwin arm64";
// Yarn 1 sets npm_execpath to the file its process started from (`makeEnv` in yarnpkg/yarn).
const yarn1 = {
  npm_config_user_agent: YARN_1,
  npm_execpath: "/usr/local/lib/node_modules/yarn/bin/yarn.js",
};
const CLI_STOP =
  "create-project-calavera does not support Yarn 1.22.22. Use Yarn 2 or later (yarn dlx create-project-calavera), npm (npx --package create-project-calavera create-project-calavera), pnpm (pnpm dlx create-project-calavera), or Bun (bunx create-project-calavera).";
const MCP_STOP =
  "create-project-calavera-mcp does not support Yarn 1.22.22. Use Yarn 2 or later (yarn dlx --package create-project-calavera create-project-calavera-mcp), npm (npx --package create-project-calavera create-project-calavera-mcp), pnpm (pnpm dlx --package create-project-calavera create-project-calavera-mcp), or Bun (bunx --package create-project-calavera create-project-calavera-mcp).";

test("the stop names one runnable command for each supported package manager, per bin", () => {
  assert.equal(unsupportedYarnMessage("create-project-calavera", "1.22.22"), CLI_STOP);
  assert.equal(unsupportedYarnMessage("create-project-calavera-mcp", "1.22.22"), MCP_STOP);
});

/** A registry on 127.0.0.1 that records every request and answers none of them usefully. */
async function startRegistry() {
  /** @type {string[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done(undefined));
      }),
  };
}

/** @param {import("node:test").TestContext} t */
async function temporaryProject(t) {
  const project = await mkdtemp(join(tmpdir(), "calavera-unsupported-yarn-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "unsupported-yarn", private: true }, null, 2)}\n`,
  );
  return project;
}

/**
 * Runs the CLI in `cwd` with the version check on, against `registry`.
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} registry
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(cwd, args, registry, env) {
  const childEnv = {
    ...process.env,
    npm_config_registry: registry,
    npm_config_userconfig: join(cwd, "missing.npmrc"),
    ...env,
  };
  // The suite's setup module turns the version check off; the stop must come before it.
  for (const name of ["CALAVERA_NO_VERSION_CHECK", "CALAVERA_DEBUG"]) delete childEnv[name];
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: childEnv, timeout: 60_000 },
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

test("under Yarn 1, the CLI prints one message, exits 1, writes nothing, and asks no registry", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());
  const before = await readdir(project);

  const result = await runCli(project, ["--yes", "--init"], registry.url, yarn1);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), CLI_STOP);
  assert.deepEqual(registry.requests, []);
  assert.deepEqual(await readdir(project), before);
});

test("under Yarn 0, the CLI stops too, and every command stops, including --help", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());

  const yarn0 = await runCli(project, ["--help"], registry.url, {
    ...yarn1,
    npm_config_user_agent: "yarn/0.27.5 npm/? node/v24.3.0 darwin arm64",
  });
  assert.equal(yarn0.code, 1);
  assert.equal(yarn0.stderr.trim(), CLI_STOP.replace("1.22.22", "0.27.5"));

  for (const args of [
    ["apply", "--dry-run"],
    ["artifacts", "status"],
    ["doctor"],
    ["eject", "--dry-run"],
  ]) {
    const result = await runCli(project, args, registry.url, yarn1);
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(result.stderr.trim(), CLI_STOP, args.join(" "));
  }
  assert.deepEqual(registry.requests, []);
});

test("under Yarn 1 with --json, the CLI prints the JSON error result on standard output", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());

  const result = await runCli(project, ["apply", "--dry-run", "--json"], registry.url, yarn1);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    command: "apply",
    ok: false,
    issues: [{ level: "error", message: CLI_STOP }],
  });
});

test("an argument error still comes first under Yarn 1, because parsing reads only the arguments", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());

  const result = await runCli(project, ["--no-such-flag"], registry.url, yarn1);

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /does not support Yarn/);
});

test("a Yarn 1 user agent under npm or pnpm, which a project file can set, does not stop the CLI", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());

  for (const execpath of [
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/bin/pnpm",
  ]) {
    const result = await runCli(project, ["--help"], registry.url, {
      ...yarn1,
      npm_execpath: execpath,
      CALAVERA_NO_VERSION_CHECK: "1",
    });
    assert.equal(result.code, 0, `${execpath}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /does not support Yarn/);
  }
});

test("Yarn 2 or later does not stop the CLI", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());

  const result = await runCli(project, ["--help"], registry.url, {
    ...yarn1,
    npm_config_user_agent: "yarn/4.19.0 npm/? node/v24.3.0 darwin arm64",
    CALAVERA_NO_VERSION_CHECK: "1",
  });
  assert.equal(result.code, 0, result.stderr);
});

test("under Yarn 1, the MCP server writes one line, sets exit code 1, and never starts", async () => {
  /** @type {string[]} */
  const written = [];
  /** @type {number[]} */
  const codes = [];
  let started = false;
  const cwd = await mkdtemp(join(tmpdir(), "calavera-unsupported-yarn-mcp-"));
  try {
    await runMcpEntrypoint({
      cwd,
      env: yarn1,
      startServer: async () => {
        started = true;
      },
      stderr: { write: (text) => written.push(String(text)) > 0 },
      setExitCode: (code) => codes.push(code),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  assert.equal(started, false);
  assert.deepEqual(codes, [1]);
  assert.deepEqual(written, [`${MCP_STOP}\n`]);
});

test("under npm with a Yarn 1 user agent, the MCP server starts", async () => {
  let started = false;
  await runMcpEntrypoint({
    env: { ...yarn1, npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js" },
    startServer: async () => {
      started = true;
    },
    stderr: { write: () => true },
    setExitCode: () => {},
  });
  assert.equal(started, true);
});
