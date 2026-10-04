// Smoke test for the shipped bins on the Node.js running this script (#626).
// CI runs it on the lowest Node.js that engines.node allows; the full test
// suite needs a newer Node.js, because it uses `await using`. It runs the bins,
// not src, needs no network, and writes only to temporary directories.
//
// Run: pnpm --filter create-project-calavera smoke:node-floor
// When CALAVERA_EXPECTED_NODE is set, as in CI, the script first checks that
// it names the lowest version engines.node allows and that this Node.js is
// exactly that version, so a passing run proves it ran on the floor.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import semver from "semver";
import packageJson from "../package.json" with { type: "json" };
import { buildRecipe } from "../src/recipe.js";

const execFileAsync = promisify(execFile);
const cliBin = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));
const mcpBin = fileURLToPath(new URL("../bin/create-project-calavera-mcp.js", import.meta.url));
const libraryFixture = fileURLToPath(
  new URL("../fixtures/vite-plus/1.0.0/library/", import.meta.url),
);

/**
 * Runs `callback` in a new temporary directory and removes it afterward.
 *
 * @param {(directory: string) => Promise<void>} callback
 */
async function inTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "calavera-node-floor-smoke-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs the CLI bin with `args` in `cwd`.
 *
 * @param {string[]} args
 * @param {string} cwd
 */
async function runCli(args, cwd) {
  return execFileAsync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/**
 * @param {string} name
 * @param {() => Promise<void>} step
 */
async function smoke(name, step) {
  await step();
  console.info(`ok - ${name}`);
}

console.info(`Node.js ${process.version}; engines.node ${packageJson.engines.node}`);

const expectedNode = process.env.CALAVERA_EXPECTED_NODE;

if (expectedNode !== undefined) {
  await smoke(`this is the lowest Node.js engines.node allows, ${expectedNode}`, async () => {
    assert.equal(
      expectedNode,
      semver.minVersion(packageJson.engines.node)?.version,
      "CALAVERA_EXPECTED_NODE must name the lowest version engines.node allows",
    );
    assert.equal(process.versions.node, expectedNode, "this Node.js is not the expected version");
  });
}

await smoke("create-project-calavera --help", async () => {
  await inTemporaryDirectory(async (directory) => {
    const { stdout } = await runCli(["--help"], directory);

    assert.ok(stdout.startsWith(`create-project-calavera ${packageJson.version}\n`), stdout);
  });
});

await smoke("create-project-calavera --init --dry-run --json writes nothing", async () => {
  await inTemporaryDirectory(async (directory) => {
    const { stdout } = await runCli(["--init", "--dry-run", "--json"], directory);
    const result = JSON.parse(stdout);

    assert.equal(result.command, "agent-init");
    assert.equal(result.dryRun, true);
    assert.ok(result.changes.some(({ path }) => path === ".agents/skills/calavera"));
    assert.deepEqual(await readdir(directory), []);
  });
});

await smoke(
  "create-project-calavera apply --dry-run --json on a Vite+ library writes nothing",
  async () => {
    await inTemporaryDirectory(async (directory) => {
      await cp(libraryFixture, directory, { recursive: true });
      await writeFile(
        join(directory, "calavera.config.json"),
        `${JSON.stringify(buildRecipe("default", ["editorconfig"], "pnpm"), null, 2)}\n`,
      );
      const before = (await readdir(directory)).sort();

      const { stdout } = await runCli(["apply", "--dry-run", "--json"], directory);
      const result = JSON.parse(stdout);

      assert.equal(result.command, "apply");
      assert.equal(result.dryRun, true);
      assert.ok(
        result.changes.some(({ type, path }) => type === "write" && path === ".editorconfig"),
      );
      assert.deepEqual((await readdir(directory)).sort(), before);
    });
  },
);

await smoke("create-project-calavera-mcp initializes over stdio", async () => {
  const client = new Client({ name: "calavera-node-floor-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpBin],
  });

  try {
    await client.connect(transport);

    assert.deepEqual(client.getServerVersion(), {
      name: "create-project-calavera",
      version: packageJson.version,
    });
    const { tools } = await client.listTools();
    assert.ok(tools.some(({ name }) => name === "dry_run_apply"));
  } finally {
    await client.close();
  }
});
