// ADR-0023: Calavera does not support Yarn 1. These tests cover the rule that recognizes a Yarn 1
// launcher (Decision 2) and the registry settings loader's refusal (Decision 5).
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { unsupportedYarnVersion } from "../src/launcher-config.js";
import { loadNpmRegistryOptions } from "../src/npm-config.js";
import * as registry from "../src/registry.js";
import { removeTemporaryDirectories, temporaryDirectory } from "./temporary-directory.mjs";

afterEach(removeTemporaryDirectories);

const YARN_1 = "yarn/1.22.22 npm/? node/v24.3.0 darwin arm64";
// Yarn 1 sets npm_execpath to the file its process started from (`makeEnv` in yarnpkg/yarn).
const YARN_1_EXECPATH = "/usr/local/lib/node_modules/yarn/bin/yarn.js";
const yarn1 = { npm_config_user_agent: YARN_1, npm_execpath: YARN_1_EXECPATH };

/** @param {Record<string, string>} [files] */
async function project(files = {}) {
  const cwd = await temporaryDirectory("calavera-unsupported-yarn-");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  return cwd;
}

test("a Yarn 1 or Yarn 0 launcher under Node.js is unsupported, with its version", async () => {
  const cwd = await project();
  assert.equal(await unsupportedYarnVersion({ env: yarn1, runtime: "node", cwd }), "1.22.22");
  assert.equal(
    await unsupportedYarnVersion({
      env: { ...yarn1, npm_config_user_agent: "yarn/0.27.5 npm/? node/v24.3.0 darwin arm64" },
      runtime: "node",
      cwd,
    }),
    "0.27.5",
  );
  // No npm_execpath at all, as when a caller sets only the user agent, is not npm or pnpm either.
  assert.equal(
    await unsupportedYarnVersion({ env: { npm_config_user_agent: YARN_1 }, runtime: "node", cwd }),
    "1.22.22",
  );
});

test("npm or pnpm in npm_execpath wins over a Yarn 1 user agent, which a project file can set", async () => {
  const cwd = await project();
  for (const execpath of [
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/bin/pnpm",
    "C:\\pnpm\\pnpm.exe",
    "/pnpm/bin/pnpm.cjs",
    "/pnpm/bin/pnpm.mjs",
    "/pnpm/bin/pnpm.js",
  ]) {
    assert.equal(
      await unsupportedYarnVersion({
        env: { npm_config_user_agent: YARN_1, npm_execpath: execpath },
        runtime: "node",
        cwd,
      }),
      undefined,
      execpath,
    );
  }
});

test("Yarn 2 or later, a Yarn without a readable version, and other launchers are supported", async () => {
  const cwd = await project();
  for (const agent of [
    "yarn/2.4.3 npm/? node/v24.3.0 darwin arm64",
    "yarn/4.19.0 npm/? node/v24.3.0 darwin arm64",
    "yarn/10.0.0 npm/? node/v24.3.0 darwin arm64",
    "yarn/unknown npm/? node/v24.3.0 darwin arm64",
    "yarn/ npm/?",
    "npm/11.20.0 yarn/1.22.22",
    "bun/1.3.9 npm/? node/v24.3.0 darwin arm64",
    "",
  ]) {
    assert.equal(
      await unsupportedYarnVersion({
        env: { npm_config_user_agent: agent, npm_execpath: YARN_1_EXECPATH },
        runtime: "node",
        cwd,
      }),
      undefined,
      agent,
    );
  }
  assert.equal(await unsupportedYarnVersion({ env: {}, runtime: "node", cwd }), undefined);
});

test("the version keeps only version characters, so a crafted user agent cannot print more", async () => {
  const cwd = await project();
  assert.equal(
    await unsupportedYarnVersion({
      env: { ...yarn1, npm_config_user_agent: "yarn/1.22.22\u001b[2J;rm npm/?" },
      runtime: "node",
      cwd,
    }),
    "1.22.22",
  );
});

test("under the Bun runtime, a launcher variable that a .env file Bun may have loaded defines does not count", async () => {
  for (const [file, content] of [
    [".env", `npm_config_user_agent=${YARN_1}\n`],
    [".env", `npm_execpath=${YARN_1_EXECPATH}\n`],
    [".env.development", `npm_config_user_agent="${YARN_1}"\n`],
    [".env.local", `npm_config_user_agent=${YARN_1}\n`],
    [".env.development.local", `npm_config_user_agent=${YARN_1}\n`],
    // A value with a variable may have been expanded from the caller's environment.
    [".env", "npm_config_user_agent=${UNRELATED}\n"],
  ]) {
    const cwd = await project({ [file]: content });
    assert.equal(
      await unsupportedYarnVersion({ env: yarn1, runtime: "bun", cwd, execArgv: [] }),
      undefined,
      `${file}: ${content}`,
    );
  }
  // A file that --env-file names counts too.
  const named = await project({ "config/ci.env": `npm_config_user_agent=${YARN_1}\n` });
  assert.equal(
    await unsupportedYarnVersion({
      env: yarn1,
      runtime: "bun",
      cwd: named,
      execArgv: ["--env-file=config/ci.env"],
    }),
    undefined,
  );
});

test("under the Bun runtime, a .env file that defines another value leaves the caller's Yarn 1 variables", async () => {
  // Bun keeps a variable that the caller already set, so a different file value is not what Calavera sees.
  const cwd = await project({ ".env": "npm_config_user_agent=bun/1.3.9 npm/?\nOTHER=1\n" });
  assert.equal(
    await unsupportedYarnVersion({ env: yarn1, runtime: "bun", cwd, execArgv: [] }),
    "1.22.22",
  );
});

test("under the Bun runtime, an unreadable .env file means the launcher variables may come from it", async () => {
  const cwd = await project();
  // A folder named .env exists but cannot be read as a file.
  await mkdir(join(cwd, ".env"));
  assert.equal(
    await unsupportedYarnVersion({ env: yarn1, runtime: "bun", cwd, execArgv: [] }),
    undefined,
  );
});

test("under the Bun runtime, the detection prints nothing, even when a file it reads cannot be read", async (t) => {
  // Under NODE_ENV=production, Bun's mode chain is production, and the development files are read
  // only to see whether one set NODE_ENV. An unreadable one leaves the production chain, which
  // defines no launcher variable, so the run stops, and the read problem must reach no output.
  const cwd = await project();
  await mkdir(join(cwd, ".env.development"));
  /** @type {unknown[]} */
  const printed = [];
  t.mock.method(process.stderr, "write", (/** @type {unknown} */ chunk) => printed.push(chunk) > 0);
  t.mock.method(process.stdout, "write", (/** @type {unknown} */ chunk) => printed.push(chunk) > 0);
  for (const method of /** @type {const} */ (["error", "warn", "info", "log"])) {
    t.mock.method(console, method, (/** @type {unknown[]} */ ...args) => printed.push(args));
  }
  const version = await unsupportedYarnVersion({
    env: { ...yarn1, NODE_ENV: "production" },
    runtime: "bun",
    cwd,
    execArgv: [],
  });
  t.mock.restoreAll();
  assert.equal(version, "1.22.22");
  assert.deepEqual(printed, []);
});

test("under the Bun runtime, the detection reads only the .env files Bun may have loaded", async () => {
  // Files that are not .env files are not read: unreadable ones change nothing.
  const cwd = await project();
  for (const name of [".npmrc", ".yarnrc.yml", "bunfig.toml", ".env.example", "env"]) {
    await mkdir(join(cwd, name));
  }
  assert.equal(
    await unsupportedYarnVersion({ env: yarn1, runtime: "bun", cwd, execArgv: [] }),
    "1.22.22",
  );
});

test("under Node.js, no .env file counts, because no Bun process loaded one", async () => {
  const cwd = await project({ ".env": `npm_config_user_agent=${YARN_1}\n` });
  assert.equal(await unsupportedYarnVersion({ env: yarn1, runtime: "node", cwd }), "1.22.22");
  // An unreadable .env is not read at all under Node.js.
  const unreadable = await project();
  await mkdir(join(unreadable, ".env"));
  assert.equal(
    await unsupportedYarnVersion({ env: yarn1, runtime: "node", cwd: unreadable }),
    "1.22.22",
  );
});

test("the registry settings loader refuses to run under Yarn 1 before it reads any configuration file", async () => {
  // Each file would fail to parse or be unreadable, which the loader reports as a warning when it reads it.
  const cwd = await project({ ".npmrc": "registry=\n", ".yarnrc.yml": "npmRegistryServer: [" });
  await mkdir(join(cwd, "home", ".npmrc"), { recursive: true });
  await assert.rejects(
    loadNpmRegistryOptions({
      cwd,
      env: { ...yarn1, HOME: join(cwd, "home") },
      accountHome: join(cwd, "home"),
      runtime: "node",
    }),
    {
      message: "Calavera does not support Yarn 1.22.22. Use Yarn 2 or later, npm, pnpm, or Bun.",
    },
  );
});

test("the registry entry exports the rule, so the CLI and the MCP server share it", () => {
  assert.equal(registry.unsupportedYarnVersion, unsupportedYarnVersion);
});
