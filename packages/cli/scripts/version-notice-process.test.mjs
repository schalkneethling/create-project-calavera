// Tests for issue #675: the CLI adapter of the version notice (ADR-0019 Decision 7). Each test
// starts the CLI as a process against a registry on 127.0.0.1, named in npm_config_registry, so no
// test reaches an outside network. The suite's setup module turns the check off for every other
// test; these tests delete the switch from the child environment they build.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };
import { VERSION_CHECK_DEADLINE_MS } from "../src/version-notice.js";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const NEWER = `${Number(packageJson.version.split(".")[0]) + 1}.0.0`;
// What a run may take beyond the deadline: process start-up and shutdown on a busy machine.
const MARGIN_MS = 2_500;

/**
 * A registry on 127.0.0.1. With `latest`, it answers every package document request with that
 * dist-tag; without it, it accepts the connection and never answers.
 * @param {string} [latest]
 */
async function startRegistry(latest) {
  /** @type {string[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (latest === undefined) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: packageJson.name,
        "dist-tags": { latest },
        versions: { [latest]: { name: packageJson.name, version: latest } },
      }),
    );
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

/**
 * @param {import("node:test").TestContext} t
 */
async function temporaryProject(t) {
  const project = await mkdtemp(join(tmpdir(), "calavera-version-notice-process-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "version-notice", private: true }, null, 2)}\n`,
  );
  return project;
}

/**
 * Runs the CLI in `cwd` with the check on, against `registry`, unless `env` turns it off.
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} registry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, elapsed: number }>}
 */
function runCli(cwd, args, registry, env = {}) {
  const childEnv = {
    ...process.env,
    npm_config_registry: registry,
    npm_config_userconfig: join(cwd, "missing.npmrc"),
    npm_config_user_agent: "npm/11.6.0 node/v24.15.0 darwin arm64",
    ...env,
  };
  // The suite's setup module sets the switch, and a developer's shell may set either variable.
  for (const name of ["CALAVERA_NO_VERSION_CHECK", "CALAVERA_DEBUG"]) {
    if (!(name in env)) delete childEnv[name];
  }
  const started = performance.now();
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
          elapsed: performance.now() - started,
        });
      },
    );
  });
}

const initArgs = ["--init", "--dry-run", "--yes"];

test("a registry that never answers adds at most the deadline and changes no output or exit code", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());

  const off = await runCli(project, initArgs, registry.url, { CALAVERA_NO_VERSION_CHECK: "1" });
  const hung = await runCli(project, initArgs, registry.url);

  assert.equal(off.code, 0, off.stderr);
  assert.ok(registry.requests.length > 0, "the check did not reach the registry");
  assert.equal(hung.code, off.code);
  assert.equal(hung.stdout, off.stdout);
  assert.equal(hung.stderr, off.stderr);
  assert.ok(
    hung.elapsed < off.elapsed + VERSION_CHECK_DEADLINE_MS + MARGIN_MS,
    `the run took ${Math.round(hung.elapsed)} ms; without the check, ${Math.round(off.elapsed)} ms`,
  );
});

test("an older version prints the notice on standard error, not standard output, pinned to latest", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry(NEWER);
  t.after(() => registry.close());

  const off = await runCli(project, initArgs, registry.url, { CALAVERA_NO_VERSION_CHECK: "1" });
  const on = await runCli(project, initArgs, registry.url);

  assert.equal(on.code, 0, on.stderr);
  assert.equal(on.stdout, off.stdout);
  assert.ok(!on.stdout.includes(NEWER), on.stdout);
  assert.equal(
    on.stderr,
    `${off.stderr}${packageJson.name} ${packageJson.version} is running, but ${NEWER} is the latest release. To run ${NEWER}: npx --package ${packageJson.name}@${NEWER} create-project-calavera --init --dry-run --yes\n`,
  );
  // Standard error is not a terminal here, so the notice carries no escape codes.
  assert.ok(!on.stderr.includes("\u001b["), JSON.stringify(on.stderr));
});

test("the notice repeats the run through the launching package manager", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry(NEWER);
  t.after(() => registry.close());

  const pnpm = await runCli(project, initArgs, registry.url, {
    npm_config_user_agent: "pnpm/11.28.10 npm/? node/v24.15.0 darwin arm64",
  });
  assert.match(
    pnpm.stderr,
    new RegExp(
      `To run ${NEWER.replaceAll(".", "\\.")}: pnpm dlx --package ${packageJson.name}@${NEWER.replaceAll(".", "\\.")} create-project-calavera --init --dry-run --yes\\n$`,
    ),
  );
});

test("a failed command still exits 1 and prints the notice after its error", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry(NEWER);
  t.after(() => registry.close());

  const failed = await runCli(project, ["apply", "--config", "missing.json"], registry.url);

  assert.equal(failed.code, 1);
  const noticeAt = failed.stderr.indexOf(`but ${NEWER} is the latest release`);
  assert.ok(noticeAt > 0, failed.stderr);
  assert.ok(failed.stderr.slice(0, noticeAt).includes("missing.json"), failed.stderr);
  assert.ok(!failed.stdout.includes(NEWER), failed.stdout);
});

test("--json, --help, the switch, and an offline artifact command make no request", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry(NEWER);
  t.after(() => registry.close());

  for (const [args, env] of /** @type {[string[], NodeJS.ProcessEnv][]} */ ([
    [["doctor", "--json"], {}],
    [["--help"], {}],
    [initArgs, { CALAVERA_NO_VERSION_CHECK: "true" }],
    [["artifacts", "status"], {}],
  ])) {
    const result = await runCli(project, args, registry.url, env);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(NEWER), args.join(" "));
  }
  assert.deepEqual(registry.requests, []);
});

test("with CALAVERA_DEBUG, a failed check says why on standard error", async (t) => {
  const project = await temporaryProject(t);
  const registry = await startRegistry();
  t.after(() => registry.close());

  const debug = await runCli(project, initArgs, registry.url, { CALAVERA_DEBUG: "1" });
  assert.equal(debug.code, 0, debug.stderr);
  assert.match(debug.stderr, /The check for a newer create-project-calavera failed/);
  assert.match(debug.stderr, /did not answer within 1500 ms/);
  assert.ok(!debug.stdout.includes("The check for a newer"), debug.stdout);
});
