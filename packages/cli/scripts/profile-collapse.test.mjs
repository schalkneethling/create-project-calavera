// CAL-011 (ADR-0011): the Modern and Classic profiles collapse into one
// default profile beside Minimal, and the ADR-0001 Vite+ detection result is
// reported by explain_recipe, compose_recipe, and dry_run_apply.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { integrationCatalog } from "../src/catalog.js";
import { parseArgs } from "../src/index.js";
import { callMcpTool, createMcpServer } from "../src/mcp.js";
import {
  buildRecipe,
  composeRecipe,
  profileDefaults,
  profileIdsForRecipe,
  validateRecipe,
} from "../src/recipe.js";
import {
  createTemporaryFixture,
  json,
  libraryManifest,
  plainViteManifest,
  vitePlusConfig,
} from "./vite-plus-fixtures.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const removedProfileIds = ["modern", "classic"];
const expectedProfileIds = ["default", "minimal"];

const managedLines = [
  "Vite+ detection: managed. This project is vp-managed (vite-plus-dependency signal at package.json).",
  "JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera.",
];
const unmanagedLines = [
  "Vite+ detection: unmanaged. No vite-plus dependency was found in this manifest or any ancestor manifest.",
  "Calavera provides no JavaScript or TypeScript toolchain; run vp create or vp migrate to adopt Vite+.",
];

/**
 * Calls a tool through the registered MCP server, so the tool's input schema
 * runs, unlike callMcpTool, which invokes the handler directly.
 *
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function callRegisteredTool(name, args) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-profile-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

/** @param {string} removedId */
function removedProfileMessage(removedId) {
  return new RegExp(
    `Invalid profile: ${removedId}\\. Allowed values: default, minimal\\. The ${removedId} profile was removed; use default instead\\.`,
  );
}

/**
 * Runs `callback` with the process working directory set to `directory`, as
 * the MCP tools and the CLI read the project from `process.cwd()`.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const originalDirectory = process.cwd();
  process.chdir(directory);

  try {
    return await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

async function managedFixture() {
  return createTemporaryFixture("profiles-managed", {
    "package.json": json(libraryManifest),
    "vite.config.ts": vitePlusConfig,
  });
}

async function unmanagedFixture() {
  return createTemporaryFixture("profiles-unmanaged", {
    "package.json": json(plainViteManifest),
  });
}

test("list_profiles exposes exactly the default and minimal profiles", async () => {
  const response = await callMcpTool("list_profiles");

  assert.deepEqual(
    response.profiles.map(({ id }) => id),
    expectedProfileIds,
  );
  assert.deepEqual(profileIdsForRecipe(), expectedProfileIds);
  assert.deepEqual(Object.keys(profileDefaults).sort(), [...expectedProfileIds].sort());
  assert.deepEqual(profileDefaults.default, [
    "editorconfig",
    "stylelint",
    "stylelint-standard",
    "stylelint-baseline",
  ]);
  assert.deepEqual(profileDefaults.minimal, ["editorconfig"]);
});

test("list_integrations offers react-doctor to the default profile and no removed profile", async () => {
  const response = await callMcpTool("list_integrations");
  const reactDoctor = response.integrations.find(({ id }) => id === "react-doctor");

  assert.deepEqual(reactDoctor?.profiles, ["default"]);

  for (const integration of response.integrations) {
    for (const removedId of removedProfileIds) {
      assert.equal(
        integration.profiles.includes(removedId),
        false,
        `${integration.id} is still offered to the removed ${removedId} profile.`,
      );
    }
  }
});

test("recipe validation rejects the removed profile ids by name and names the replacement", () => {
  for (const removedId of removedProfileIds) {
    assert.throws(
      () => validateRecipe(buildRecipe(removedId, ["editorconfig"], "npm")),
      removedProfileMessage(removedId),
    );
    assert.throws(() => composeRecipe({ profile: removedId }), removedProfileMessage(removedId));
    assert.throws(
      () => parseArgs(["init", "--profile", removedId]),
      removedProfileMessage(removedId),
    );
  }
});

test("MCP validate_recipe and compose_recipe reject the removed profile ids", async () => {
  for (const removedId of removedProfileIds) {
    const validation = await callMcpTool("validate_recipe", {
      recipe: buildRecipe(removedId, ["editorconfig"], "npm"),
    });

    assert.equal(validation.ok, false);
    assert.match(validation.errors.join("\n"), removedProfileMessage(removedId));
    await assert.rejects(
      () => callMcpTool("compose_recipe", { profile: removedId }),
      removedProfileMessage(removedId),
    );
    // Through the registered tool the input schema runs first and the server answers with an
    // error result; it must carry the same message.
    for (const name of ["compose_recipe", "list_integrations"]) {
      const result = await callRegisteredTool(name, { profile: removedId });
      assert.equal(result.isError, true, `${name} accepted ${removedId}`);
      assert.match(
        result.content.map(({ text }) => text).join("\n"),
        removedProfileMessage(removedId),
      );
    }
  }
});

test("the CLI apply path rejects a config naming a removed profile", async () => {
  for (const removedId of removedProfileIds) {
    await using fixture = await unmanagedFixture();
    const binPath = join(fixture.root, "create-project-calavera");
    await symlink(cliPath, binPath);
    await writeFile(
      join(fixture.root, "calavera.config.json"),
      json(buildRecipe(removedId, ["editorconfig"], "npm")),
    );

    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [binPath, "apply", "--dry-run"], {
          cwd: fixture.root,
          env: { ...process.env, NO_COLOR: "1" },
        }),
      (error) => {
        assert.match(String(error.stderr), removedProfileMessage(removedId));
        return true;
      },
    );
  }
});

test("explain_recipe reports a vp-managed project and what Vite+ provides", async () => {
  await using fixture = await managedFixture();
  const response = await inDirectory(fixture.root, () =>
    callMcpTool("explain_recipe", { recipe: composeRecipe({ profile: "default" }) }),
  );

  assert.equal(response.vitePlus.status, "managed");
  assert.equal(response.vitePlus.signalConflict, false);
  assert.deepEqual(response.vitePlus.lines, managedLines);
});

test("explain_recipe reports a plain Vite project as unmanaged", async () => {
  await using fixture = await unmanagedFixture();
  const response = await inDirectory(fixture.root, () =>
    callMcpTool("explain_recipe", { recipe: composeRecipe({ profile: "default" }) }),
  );

  assert.equal(response.vitePlus.status, "unmanaged");
  assert.equal(response.vitePlus.signalConflict, false);
  assert.deepEqual(response.vitePlus.lines, unmanagedLines);
});

test("dry_run_apply reports a vp-managed project and what Vite+ provides", async () => {
  await using fixture = await managedFixture();
  const response = await inDirectory(fixture.root, () =>
    callMcpTool("dry_run_apply", { recipe: composeRecipe({ profile: "default" }) }),
  );

  assert.equal(response.result.dryRun, true);
  assert.equal(response.result.vitePlus.status, "managed");
  assert.deepEqual(response.result.vitePlus.lines, managedLines);
});

test("dry_run_apply reports a plain Vite project as unmanaged", async () => {
  await using fixture = await unmanagedFixture();
  const response = await inDirectory(fixture.root, () =>
    callMcpTool("dry_run_apply", { recipe: composeRecipe({ profile: "default" }) }),
  );

  assert.equal(response.result.dryRun, true);
  assert.equal(response.result.vitePlus.status, "unmanaged");
  assert.deepEqual(response.result.vitePlus.lines, unmanagedLines);
});

test("dry_run_apply reports a signal conflict on an unmanaged project that calls vp", async () => {
  await using fixture = await createTemporaryFixture("profiles-conflict", {
    "package.json": json({ name: "conflict", scripts: { build: "vp build" } }),
  });
  const response = await inDirectory(fixture.root, () =>
    callMcpTool("dry_run_apply", { recipe: composeRecipe({ profile: "minimal" }) }),
  );

  assert.equal(response.result.vitePlus.status, "unmanaged");
  assert.equal(response.result.vitePlus.signalConflict, true);
  assert.deepEqual(response.result.vitePlus.lines, [
    unmanagedLines[0],
    "Vite+ signal conflict: found vp-scripts without a vite-plus dependency; confirm whether the vite-plus dependency was removed intentionally.",
    unmanagedLines[1],
  ]);
});

test("explain_recipe reports an unreadable project manifest as unknown", async () => {
  await using fixture = await createTemporaryFixture("profiles-unknown", { "package.json": "{" });
  const response = await inDirectory(fixture.root, () =>
    callMcpTool("explain_recipe", { recipe: composeRecipe({ profile: "minimal" }) }),
  );

  assert.equal(response.vitePlus.status, "unknown");
  assert.equal(
    response.vitePlus.lines[0],
    "Vite+ detection: unknown. package.json could not be read, so Vite+ management could not be determined.",
  );
});

test("compose_recipe on a managed project offers no JS or TS toolchain and says why", async () => {
  await using fixture = await managedFixture();
  const response = await inDirectory(fixture.root, () =>
    callMcpTool("compose_recipe", { profile: "default" }),
  );
  const toolchainGroups = /JS\/TS|JavaScript|TypeScript|Formatting/;

  assert.deepEqual(response.recipe.integrations, profileDefaults.default);
  assert.equal(
    integrationCatalog.some(({ group }) => toolchainGroups.test(group)),
    false,
    "No catalog entry may belong to a JavaScript or TypeScript toolchain group.",
  );
  assert.equal(response.vitePlus.status, "managed");
  assert.deepEqual(response.vitePlus.lines, managedLines);
});

test("the CLI apply dry run prints the Vite+ detection lines", async () => {
  await using fixture = await managedFixture();
  const binPath = join(fixture.root, "create-project-calavera");
  await symlink(cliPath, binPath);
  await writeFile(
    join(fixture.root, "calavera.config.json"),
    json(composeRecipe({ profile: "default" })),
  );

  const { stdout } = await execFileAsync(process.execPath, [binPath, "apply", "--dry-run"], {
    cwd: fixture.root,
    env: { ...process.env, NO_COLOR: "1" },
  });

  for (const line of managedLines) {
    assert.ok(stdout.includes(line), `Missing "${line}" in:\n${stdout}`);
  }
});

test("Composer schema enum and profile choices carry exactly the catalog profiles", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL("../../../apps/composer/public/calavera.config.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const html = await readFile(
    new URL("../../../apps/composer/index.html", import.meta.url),
    "utf8",
  );
  const radios = [...html.matchAll(/<input\b[^>]*\bname="profile"[^>]*>/g)].map(([tag]) => tag);
  const radioValues = radios.map((tag) => /\bvalue="([^"]+)"/.exec(tag)?.[1]);
  const checkedValues = radios
    .filter((tag) => /\bchecked\b/.test(tag))
    .map((tag) => /\bvalue="([^"]+)"/.exec(tag)?.[1]);

  assert.deepEqual(schema.properties.profile.enum, profileIdsForRecipe());
  assert.deepEqual(radioValues, profileIdsForRecipe());
  assert.deepEqual(checkedValues, ["default"]);

  for (const removedId of removedProfileIds) {
    assert.equal(html.includes(`value="${removedId}"`), false);
  }
});
