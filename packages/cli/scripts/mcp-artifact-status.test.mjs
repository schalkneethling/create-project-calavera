// #1052 (ADR-0018 Decisions 1 and 3, ADR-0020 Decision 1): the read-only `artifact_status` MCP tool
// reports artifact status from the same core function as `artifacts status`, and writes nothing
// into the project. Unlike the command, it never recovers a pending artifact transaction, never
// writes or records the artifact cache block, never loads the project's formatter, and resolves
// `checkUpdates` lookups through a temporary cache outside the project.
import assert from "node:assert/strict";
import { mkdtempDisposable, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { resolveArtifactPackage } from "@schalkneethling/calavera-artifact-core/registry";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { callMcpTool, createMcpServer } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { mcpOnlyToolSchemas, sharedToolSchemas } from "../src/tool-schemas.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";

const ARTIFACT_ID = "skill-project-goal";
const LOCKED_VERSION = "0.1.0";
const NEWER_VERSION = "0.2.0";

/** @param {string} prefix @param {(directory: string) => Promise<void>} callback */
async function inProject(prefix, callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), prefix));
  const directory = await realpath(project.path);
  const originalDirectory = process.cwd();
  process.chdir(directory);
  try {
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await callback(directory);
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * A project that `artifacts install` locked at LOCKED_VERSION, with no artifact cache block in
 * `.gitignore`, so `artifacts status --check-updates` would write and record one.
 */
async function lockedProject(config = "calavera.config.json") {
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: ARTIFACT_ID }] }, null, 2)}\n`,
  );
  await runArtifactCommand(
    { config, dryRun: false, artifactAction: "install" },
    stubRegistry(new Map([[ARTIFACT_ID, LOCKED_VERSION]])),
  );
  await writeFile(".gitignore", "node_modules/\n");
}

/** The options `artifacts status` runs with, with or without `--check-updates`. */
const statusOptions = (/** @type {boolean} */ checkUpdates, config = "calavera.config.json") => ({
  config,
  dryRun: false,
  artifactAction: "status",
  ...(checkUpdates ? { checkUpdates: true } : {}),
});

/** A formatter loader that fails the test if it runs. */
const forbiddenFormatter = {
  loadFormatter: async () => {
    throw new Error("artifact_status must not load the project's formatter.");
  },
};

/**
 * A local npm registry that publishes ARTIFACT_ID at NEWER_VERSION, on 127.0.0.1, and records each
 * request, so a test can check for updates without the network.
 */
async function startRegistry() {
  const artifact = artifactForId(ARTIFACT_ID);
  assert.ok(artifact);
  /** @type {string[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    // Cacheable, so a lookup that used the project's own cache would leave an entry there.
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      etag: '"artifact-status-test"',
    });
    response.end(
      JSON.stringify({
        name: artifact.packageName,
        "dist-tags": { latest: NEWER_VERSION },
        versions: {
          [NEWER_VERSION]: {
            name: artifact.packageName,
            version: NEWER_VERSION,
            dist: { tarball: `${origin}/-/artifact.tgz`, integrity: `sha512-${"a".repeat(86)}==` },
          },
        },
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    requests,
    url: `http://127.0.0.1:${port}/`,
    [Symbol.asyncDispose]: () => new Promise((done) => server.close(() => done(undefined))),
  };
}

/**
 * The real npm resolver, pointed at `registryUrl` and kept away from the developer's own user
 * `.npmrc` and npm_config_* variables.
 *
 * @param {string} directory
 * @param {string} registryUrl
 */
function localResolver(directory, registryUrl) {
  return {
    resolve: (/** @type {Parameters<typeof resolveArtifactPackage>[0]} */ request) =>
      resolveArtifactPackage({
        ...request,
        cwd: directory,
        env: {
          npm_config_userconfig: join(directory, "missing.npmrc"),
          npm_config_registry: registryUrl,
        },
      }),
  };
}

/** The report without the two fields that describe the cache block the command writes. */
function withoutCacheBlock(/** @type {Record<string, unknown>} */ report) {
  const rest = { ...report };
  delete rest.ignoreChanges;
  delete rest.pointers;
  return rest;
}

/** @template T @param {(client: Client) => Promise<T>} callback */
async function withClient(callback) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-artifact-status-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listedTool() {
  return withClient(async (client) => {
    const { tools } = await client.listTools();
    return tools.find(({ name }) => name === "artifact_status");
  });
}

test("the MCP server lists artifact_status as read-only and open-world, with an output schema", async () => {
  const tool = await listedTool();

  assert.ok(tool, "the server does not list artifact_status");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(tool.outputSchema?.type, "object");
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
    "checkUpdates",
    "config",
  ]);
});

test("artifact_status is an MCP-only tool, so the Composer's WebMCP tools do not share it", () => {
  assert.ok(mcpOnlyToolSchemas.artifact_status);
  assert.equal(Object.hasOwn(sharedToolSchemas, "artifact_status"), false);
});

test("artifact_status returns the data artifacts status --json returns, offline", async () => {
  await inProject("calavera-mcp-status-offline-", async () => {
    await lockedProject();

    const fromTool = await callMcpTool("artifact_status", {}, forbiddenFormatter);
    const fromCommand = await runArtifactCommand(statusOptions(false));

    assert.deepEqual(fromTool, fromCommand);
    assert.equal(fromTool.offline, true);
  });
});

test("artifact_status with checkUpdates returns the data artifacts status --check-updates --json returns, apart from the cache block it does not write", async () => {
  await inProject("calavera-mcp-status-updates-", async () => {
    await lockedProject();
    const registry = () => stubRegistry(new Map([[ARTIFACT_ID, NEWER_VERSION]]));

    const fromTool = await callMcpTool(
      "artifact_status",
      { checkUpdates: true },
      {
        ...registry(),
        ...forbiddenFormatter,
      },
    );
    const fromCommand = await runArtifactCommand(statusOptions(true), registry());

    assert.deepEqual(withoutCacheBlock(fromTool), withoutCacheBlock(fromCommand));
    assert.equal(fromTool.artifacts[0].updateAvailable, true);
    assert.equal(fromTool.artifacts[0].latestVersion, NEWER_VERSION);
    // The command recorded the block it wrote; the tool wrote none, so it reports none.
    assert.notDeepEqual(fromCommand.ignoreChanges, []);
    assert.deepEqual(fromTool.ignoreChanges, []);
    assert.deepEqual(fromTool.pointers, []);
  });
});

test("artifact_status writes nothing into the project, with or without checkUpdates against a local registry", async () => {
  await inProject("calavera-mcp-status-snapshot-", async (directory) => {
    await lockedProject();
    await using registry = await startRegistry();
    const before = await snapshotDirectory();

    const offline = await callMcpTool("artifact_status", {}, forbiddenFormatter);
    const checked = await callMcpTool(
      "artifact_status",
      { checkUpdates: true },
      {
        ...localResolver(directory, registry.url),
        ...forbiddenFormatter,
      },
    );

    assert.deepEqual(await snapshotDirectory(), before);
    assert.equal(offline.offline, true);
    // The lookup reached the local registry and came back, so the cache it used was real.
    assert.notEqual(registry.requests.length, 0);
    assert.equal(checked.artifacts[0].latestVersion, NEWER_VERSION);
    assert.equal(checked.artifacts[0].updateAvailable, true);
  });
});

test("artifact_status reports a pending artifact transaction instead of recovering it, and writes nothing", async () => {
  await inProject("calavera-mcp-status-pending-", async () => {
    await lockedProject();
    const transactionRoot = join(process.cwd(), ".calavera/.transactions/stopped");
    await mkdir(join(transactionRoot, "backups"), { recursive: true });
    await writeFile(join(transactionRoot, "backups", "0"), "the backup a rollback restores\n");
    await writeFile(
      ".calavera/artifact-transaction.json",
      `${JSON.stringify({
        schemaVersion: 1,
        transactionRoot,
        operations: [
          {
            staged: join(transactionRoot, "staged"),
            target: join(process.cwd(), ".calavera/state.json"),
            backup: join(transactionRoot, "backups", "0"),
            hadTarget: true,
          },
        ],
      })}\n`,
    );
    const registry = stubRegistry(new Map([[ARTIFACT_ID, NEWER_VERSION]]));
    const before = await snapshotDirectory();

    await assert.rejects(
      callMcpTool(
        "artifact_status",
        { checkUpdates: true },
        { ...registry, ...forbiddenFormatter },
      ),
      (error) => {
        assert.equal(/** @type {{ code?: string }} */ (error).code, "pending-transaction");
        const { message } = /** @type {Error} */ (error);
        assert.match(message, /artifacts status/);
        // The rollback restores the state from its backup, so the person must save edits to it.
        assert.match(message, /replaces or removes these files: \.calavera\/state\.json\./);
        return true;
      },
    );

    assert.deepEqual(await snapshotDirectory(), before);
    assert.deepEqual(registry.requests, [], "a pending transaction must resolve no package");
    assert.ok((await readdir(".calavera")).includes("artifact-transaction.json"));
  });
});

test("artifact_status refuses a config path outside the project", async () => {
  await inProject("calavera-mcp-status-config-", async () => {
    await assert.rejects(
      callMcpTool("artifact_status", { config: "../elsewhere/calavera.config.json" }),
      /artifact_status config path must stay inside the current project workspace/,
    );
  });
});

test("artifact_status keeps a non-default config path in the commands it names, as artifacts status --config does", async () => {
  await inProject("calavera-mcp-status-custom-config-", async () => {
    const config = "recipes/calavera.json";
    await lockedProject(config);

    const fromTool = await callMcpTool("artifact_status", { config }, forbiddenFormatter);

    assert.deepEqual(fromTool, await runArtifactCommand(statusOptions(false, config)));
    assert.match(String(fromTool.checkUpdatesCommand), /--config recipes\/calavera\.json/);
  });
});

test("an MCP client accepts the structured result against the declared output schema, and reads a pending transaction as an error with its code", async () => {
  await inProject("calavera-mcp-status-client-", async () => {
    await lockedProject();
    // An unlocked selection too, so the result carries both kinds of artifact entry.
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: ARTIFACT_ID }, { id: "skill-release-with-confidence" }] }, null, 2)}\n`,
    );

    // The client validates `structuredContent` against the output schemas it read from tools/list.
    const result = await withClient(async (client) => {
      await client.listTools();
      return client.callTool({ name: "artifact_status", arguments: {} });
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, await runArtifactCommand(statusOptions(false)));
    assert.equal(
      /** @type {{ artifacts: unknown[] }} */ (result.structuredContent).artifacts.length,
      2,
    );

    await writeFile(
      ".calavera/artifact-transaction.json",
      `${JSON.stringify({ schemaVersion: 1, transactionRoot: "x", operations: [] })}\n`,
    );
    const pending = await withClient((client) =>
      client.callTool({ name: "artifact_status", arguments: {} }),
    );
    assert.equal(pending.isError, true);
    const [content] = /** @type {{ text: string }[]} */ (pending.content);
    assert.equal(JSON.parse(content.text).error.code, "pending-transaction");
  });
});

test("a recipe or journal artifact_status cannot read never hides the pending-transaction code", async () => {
  await inProject("calavera-mcp-status-pending-unreadable-", async () => {
    await lockedProject();
    await writeFile("calavera.config.json", "{ not json\n");
    await writeFile(".calavera/artifact-transaction.json", "{ not json either\n");
    const before = await snapshotDirectory();

    await assert.rejects(callMcpTool("artifact_status", {}), (error) => {
      assert.equal(/** @type {{ code?: string }} */ (error).code, "pending-transaction");
      const { message } = /** @type {Error} */ (error);
      assert.match(message, /cannot read the journal/);
      // The npm runner, because the recipe that names the package manager cannot be read.
      assert.match(message, /npm create project-calavera artifacts status/);
      assert.doesNotMatch(message, /not json/);
      return true;
    });
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("an MCP client accepts a lock entry whose fields the CLI also reports unchanged", async () => {
  await inProject("calavera-mcp-status-unusual-lock-", async () => {
    await lockedProject();
    const lock = JSON.parse(await readFile(".calavera/artifacts.lock.json", "utf8"));
    lock.artifacts[0].tag = "beta";
    await writeFile(".calavera/artifacts.lock.json", `${JSON.stringify(lock, null, 2)}\n`);

    const result = await withClient(async (client) => {
      await client.listTools();
      return client.callTool({ name: "artifact_status", arguments: {} });
    });

    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, await runArtifactCommand(statusOptions(false)));
  });
});

/** Writes a pending journal with `operations`, each given as project paths and whether a backup exists. */
async function pendingJournal(
  /** @type {{ target: string, hadTarget: boolean, backup: boolean }[]} */ operations,
) {
  const transactionRoot = join(process.cwd(), ".calavera/.transactions/stopped");
  await mkdir(join(transactionRoot, "backups"), { recursive: true });
  const journalOperations = [];
  for (const [index, { target, hadTarget, backup }] of operations.entries()) {
    const backupPath = join(transactionRoot, "backups", String(index));
    if (backup) await writeFile(backupPath, "backup\n");
    journalOperations.push({
      staged: join(transactionRoot, "staged", String(index)),
      target: join(process.cwd(), target),
      backup: backupPath,
      hadTarget,
    });
  }
  await writeFile(
    ".calavera/artifact-transaction.json",
    `${JSON.stringify({ schemaVersion: 1, transactionRoot, operations: journalOperations })}\n`,
  );
}

/** @param {Record<string, unknown>} [input] */
async function pendingMessage(input = {}) {
  try {
    await callMcpTool("artifact_status", input);
  } catch (error) {
    assert.equal(/** @type {{ code?: string }} */ (error).code, "pending-transaction");
    return /** @type {Error} */ (error).message;
  }
  assert.fail("artifact_status did not report the pending transaction");
}

test("the pending-transaction error names exactly the files the rollback restores or removes, and the recipe's runner", async () => {
  await inProject("calavera-mcp-status-pending-files-", async () => {
    await mkdir(".calavera");
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify(buildRecipe("minimal", [], "pnpm"), null, 2)}\n`,
    );
    await pendingJournal([
      // Restored from its backup.
      { target: "restored.md", hadTarget: true, backup: true },
      // Existed, but its backup was never made, so the rollback leaves it alone.
      { target: "untouched.md", hadTarget: true, backup: false },
      // New in the stopped operation, so the rollback removes it.
      { target: "created.md", hadTarget: false, backup: false },
    ]);

    const message = await pendingMessage();

    assert.match(message, /replaces or removes these files: restored\.md, created\.md\./);
    assert.match(message, /run: pnpm /);
  });
});

test("the pending-transaction error says when the rollback replaces no file", async () => {
  await inProject("calavera-mcp-status-pending-none-", async () => {
    await mkdir(".calavera");
    await pendingJournal([]);

    assert.match(await pendingMessage(), /The rollback replaces or removes no file\./);
  });
});
