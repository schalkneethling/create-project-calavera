// #1052 (ADR-0018 Decisions 1 and 3, ADR-0020 Decision 1): the read-only `artifact_status` MCP tool
// reports artifact status from the same core function as `artifacts status`, and writes nothing
// into the project. Unlike the command, it never recovers a pending artifact transaction, and
// returns the pending-transaction phase instead. It also never writes or records the artifact cache
// block, never loads the project's formatter, and resolves `checkUpdates` lookups through a
// temporary cache outside the project.
import assert from "node:assert/strict";
import { mkdtempDisposable, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
import { answeringRegistry, silentRegistry } from "./local-registry.mjs";

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
  // ADR-0018 Decision 6: declaring the pending-transaction fields as optional now means a later
  // result that carries phase on every call adds no field to the declared shape.
  const declared = /** @type {Record<string, { type?: unknown, anyOf?: unknown[] }>} */ (
    tool.outputSchema?.properties
  );
  assert.equal(declared.phase?.type, "string");
  assert.equal(declared.remedy?.type, "string");
  assert.deepEqual(
    declared.rollbackFiles?.anyOf?.map((option) => /** @type {{ type: string }} */ (option).type),
    ["array", "null"],
  );
  for (const field of ["phase", "rollbackFiles", "remedy"]) {
    assert.equal(tool.outputSchema?.required?.includes(field), false, `${field} is required`);
  }
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

test("artifact_status returns the pending-transaction phase instead of recovering it, and writes nothing", async () => {
  await inProject("calavera-mcp-status-pending-", async () => {
    await lockedProject();
    // The stopped operation was replacing the state, so the rollback restores it from its backup.
    await pendingJournal([{ target: ".calavera/state.json", hadTarget: true, backup: true }]);
    const registry = stubRegistry(new Map([[ARTIFACT_ID, NEWER_VERSION]]));
    const before = await snapshotDirectory();

    const report = await callMcpTool(
      "artifact_status",
      { checkUpdates: true },
      { ...registry, ...forbiddenFormatter },
    );

    assert.deepEqual(report, {
      command: "artifacts status",
      dryRun: false,
      offline: true,
      updateAllCommand: null,
      checkUpdatesCommand: null,
      updateAllBlockedBy: [],
      ok: false,
      artifacts: [],
      ignoreChanges: [],
      pointers: [],
      phase: "pending-transaction",
      rollbackFiles: [".calavera/state.json"],
      remedy:
        "An artifact operation stopped before its rollback ran, so this read-only report does not read the artifact records, because the rollback may still change them. Save any edits to the files in rollbackFiles first, then run: npm create project-calavera artifacts status. It rolls the transaction back and reports the artifact status.",
    });
    assert.deepEqual(await snapshotDirectory(), before);
    assert.deepEqual(registry.requests, [], "a pending transaction must resolve no package");
    assert.ok((await readdir(".calavera")).includes("artifact-transaction.json"));
  });
});

test("artifact_status carries phase only in the pending-transaction report", async () => {
  await inProject("calavera-mcp-status-no-phase-", async () => {
    await lockedProject();

    const report = await callMcpTool("artifact_status", {}, forbiddenFormatter);

    for (const field of ["phase", "rollbackFiles", "remedy"]) {
      assert.equal(Object.hasOwn(report, field), false, `${field} is present`);
    }
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

test("an MCP client accepts the structured result and the pending-transaction result against the declared output schema", async () => {
  await inProject("calavera-mcp-status-client-", async () => {
    await lockedProject();
    // An unlocked selection too, so the result carries both kinds of artifact entry.
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: ARTIFACT_ID }, { id: "skill-release-with-confidence" }] }, null, 2)}\n`,
    );
    // The client validates `structuredContent` against the output schemas it read from tools/list.
    const call = () =>
      withClient(async (client) => {
        await client.listTools();
        return client.callTool({ name: "artifact_status", arguments: {} });
      });

    const result = await call();
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, await runArtifactCommand(statusOptions(false)));
    assert.equal(
      /** @type {{ artifacts: unknown[] }} */ (result.structuredContent).artifacts.length,
      2,
    );

    await pendingJournal([{ target: ".agents/skills/created", hadTarget: false, backup: false }]);
    const pending = await call();
    assert.equal(pending.isError, undefined, JSON.stringify(pending.content));
    assert.equal(
      /** @type {{ phase?: string }} */ (pending.structuredContent).phase,
      "pending-transaction",
    );

    // A journal Calavera cannot read gives a null rollbackFiles, which the schema allows too.
    await writeFile(".calavera/artifact-transaction.json", "{ not json\n");
    const unreadable = await call();
    assert.equal(unreadable.isError, undefined, JSON.stringify(unreadable.content));
    assert.equal(
      /** @type {{ rollbackFiles?: unknown }} */ (unreadable.structuredContent).rollbackFiles,
      null,
    );
  });
});

test("a recipe or journal artifact_status cannot read still gives the pending-transaction report", async () => {
  await inProject("calavera-mcp-status-pending-unreadable-", async () => {
    await lockedProject();
    await writeFile("calavera.config.json", "{ not json\n");
    await writeFile(".calavera/artifact-transaction.json", "{ not json either\n");
    const before = await snapshotDirectory();

    const report = await callMcpTool("artifact_status", {});

    assert.equal(report.phase, "pending-transaction");
    assert.equal(report.rollbackFiles, null);
    assert.match(String(report.remedy), /cannot read the journal/);
    // The npm runner, because the recipe that names the package manager cannot be read.
    assert.match(String(report.remedy), /then run: npm create project-calavera artifacts status\./);
    assert.doesNotMatch(String(report.remedy), /not json/);
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

test("the pending-transaction report names exactly the files the rollback restores or removes, and the recipe's runner", async () => {
  await inProject("calavera-mcp-status-pending-files-", async () => {
    await mkdir(".calavera");
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify(buildRecipe("minimal", [], "pnpm"), null, 2)}\n`,
    );
    await pendingJournal([
      // Restored from its backup.
      { target: ".agents/skills/restored", hadTarget: true, backup: true },
      // Existed, but its backup was never made, so the rollback leaves it alone.
      { target: ".agents/skills/untouched", hadTarget: true, backup: false },
      // New in the stopped operation, so the rollback removes it.
      { target: ".agents/skills/created", hadTarget: false, backup: false },
    ]);

    const report = await callMcpTool("artifact_status", {});

    assert.deepEqual(report.rollbackFiles, [".agents/skills/restored", ".agents/skills/created"]);
    assert.match(String(report.remedy), /the files in rollbackFiles first, then run: pnpm /);
  });
});

test("the pending-transaction report says when the rollback replaces no file", async () => {
  await inProject("calavera-mcp-status-pending-none-", async () => {
    await mkdir(".calavera");
    await pendingJournal([]);

    const report = await callMcpTool("artifact_status", {});

    assert.deepEqual(report.rollbackFiles, []);
    assert.match(String(report.remedy), /restores or removes no file, so run: npm /);
  });
});

test("artifact_status removes the temporary cache it resolved through after a checkUpdates call", async () => {
  await inProject("calavera-mcp-status-temporary-cache-", async (directory) => {
    await lockedProject();
    const stub = stubRegistry(new Map([[ARTIFACT_ID, NEWER_VERSION]]));
    /** @type {{ cache: string, existed: boolean }[]} */
    const caches = [];
    const resolve = (/** @type {Parameters<typeof stub.resolve>[0]} */ request) => {
      caches.push({ cache: request.cache, existed: existsSync(request.cache) });
      return stub.resolve(request);
    };

    await callMcpTool(
      "artifact_status",
      { checkUpdates: true },
      { resolve, ...forbiddenFormatter },
    );

    assert.equal(caches.length, 1);
    const [{ cache, existed }] = caches;
    // The lookup used a real folder outside the project, and the call removed that exact folder.
    assert.equal(existed, true);
    assert.equal(cache.startsWith(directory), false, `${cache} is inside the project`);
    assert.equal(existsSync(cache), false, `${cache} was not removed`);
  });
});

test("the pending-transaction remedy keeps the caller's config path", async () => {
  await inProject("calavera-mcp-status-pending-config-", async () => {
    await mkdir(".calavera");
    await mkdir("recipes");
    await writeFile(
      "recipes/calavera.json",
      `${JSON.stringify(buildRecipe("minimal", [], "npm"), null, 2)}\n`,
    );
    await pendingJournal([{ target: ".agents/skills/created", hadTarget: false, backup: false }]);

    const report = await callMcpTool("artifact_status", { config: "recipes/calavera.json" });

    assert.match(
      String(report.remedy),
      /then run: npm create project-calavera artifacts status -- --config recipes\/calavera\.json\./,
    );
  });
});

// #1193: the status tool reads the journal through the rollback's checks, so a journal whose target
// is the project root, any other path a transaction never writes, or a path another target also
// names, lists no files.
for (const [name, targets] of [
  ["targets the project root", [".agents/skills/created", "."]],
  ["names a target twice", [".agents/skills/created", ".agents/skills/created"]],
]) {
  test(`rollbackFiles is null for a journal that ${name}`, async () => {
    await inProject("calavera-mcp-status-pending-refused-", async () => {
      await mkdir(".calavera");
      await pendingJournal(targets.map((target) => ({ target, hadTarget: false, backup: false })));
      const before = await snapshotDirectory();

      const report = await callMcpTool("artifact_status", {});

      assert.equal(report.rollbackFiles, null);
      assert.match(String(report.remedy), /or the journal fails the rollback's checks/);
      assert.deepEqual(await snapshotDirectory(), before);
    });
  });
}

// Issue #1138: the MCP tool shares the update check of `artifacts status --check-updates`, so a
// registry that never answers is reported at the lookup deadline there too, instead of holding the
// tool call open. After that lookup times out, the other artifacts on that registry are reported
// as not checked, and an artifact on another registry is still checked.
test(
  "artifact_status with checkUpdates skips a silent registry after one timeout and still checks another registry",
  { timeout: 60_000 },
  async () => {
    const deadline = 1_500;
    const silentIds = ["skill-project-goal", "skill-code-review", "skill-css-tokens"];
    const healthyId = "skill-release-with-confidence";
    const ids = [...silentIds, healthyId];
    const healthyPackage = artifactForId(healthyId)?.packageName;
    assert.ok(healthyPackage);
    await using silent = await silentRegistry();
    await using healthy = await answeringRegistry(new Map([[healthyPackage, NEWER_VERSION]]));
    await inProject("calavera-mcp-status-silent-", async (directory) => {
      await writeFile(
        "calavera.config.json",
        `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: ids.map((id) => ({ id })) }, null, 2)}\n`,
      );
      await runArtifactCommand(
        { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
        stubRegistry(new Map(ids.map((id) => [id, LOCKED_VERSION]))),
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({
        // Each artifact's registry comes from npm_config_registry, so the two registries serve
        // different artifacts.
        resolve: (/** @type {Parameters<typeof resolveArtifactPackage>[0]} */ request) =>
          localResolver(directory, request.id === healthyId ? healthy.url : silent.url).resolve(
            request,
          ),
        ...forbiddenFormatter,
        updateCheckDeadlineMs: deadline,
      });
      const client = new Client({ name: "calavera-artifact-status-test", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        await client.listTools();
        const started = performance.now();
        const result = await client.callTool({
          name: "artifact_status",
          arguments: { checkUpdates: true },
        });
        const elapsed = performance.now() - started;

        assert.equal(result.isError, undefined, JSON.stringify(result.content));
        const { artifacts } =
          /** @type {{ artifacts: { id: string, latestVersion: string | null, updateCheckFailure: { code: string, reason: string, remedy: string } | null }[] }} */ (
            result.structuredContent
          );
        const codes = artifacts
          .filter(({ id }) => silentIds.includes(id))
          .map(({ updateCheckFailure }) => updateCheckFailure?.code);
        assert.deepEqual(codes, ["ELOOKUPTIMEOUT", "ELOOKUPSKIPPED", "ELOOKUPSKIPPED"]);
        const checked = artifacts.find(({ id }) => id === healthyId);
        assert.equal(checked?.updateCheckFailure, null);
        assert.equal(checked?.latestVersion, NEWER_VERSION);
        for (const { updateCheckFailure } of artifacts.filter(({ id }) => silentIds.includes(id))) {
          assert.match(updateCheckFailure?.remedy ?? "", /^Check the network connection/);
        }
        assert.equal(silent.requests.length, 1);
        assert.ok(elapsed >= deadline, `the tool answered after ${elapsed} ms`);
        assert.ok(elapsed < silentIds.length * deadline, `the tool took ${elapsed} ms`);
        await silent.closed();
      } finally {
        await client.close();
        await server.close();
      }
    });
  },
);
