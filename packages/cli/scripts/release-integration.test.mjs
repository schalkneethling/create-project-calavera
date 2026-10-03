import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { hashArtifactPayload } from "@schalkneethling/calavera-artifact-core/registry";
import { resolveArtifactPackage as resolvePackedArtifact } from "../fixtures/packed-registry/registry.mjs";
import cliPackageJson from "../package.json" with { type: "json" };

import {
  assertPublishedCliCompatibility,
  composerRecipe,
} from "../../../apps/composer/recipe-builder.js";
import { aiArtifactOutputPaths } from "../src/ai/artifacts.js";
import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { callMcpTool } from "../src/mcp.js";
import { aiArtifactRecipeItems, buildRecipe, validateRecipe } from "../src/recipe.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const execFileAsync = promisify(execFile);
const artifactPackagesRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const packedRegistryPreload = fileURLToPath(
  new URL("../fixtures/packed-registry/register.mjs", import.meta.url),
);

/** @type {string} */
let workRoot;
/** @type {Map<string, { packageName: string, version: string, path: string, integrity: string }>} */
const packedArtifacts = new Map();

async function artifactDirectories() {
  const entries = await readdir(artifactPackagesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
}

/** @param {string} directory */
async function packArtifact(directory) {
  const packageRoot = join(artifactPackagesRoot, directory);
  const destination = join(workRoot, "tarballs", directory);
  await mkdir(destination, { recursive: true });
  await execFileAsync("pnpm", ["pack", "--pack-destination", destination], { cwd: packageRoot });
  const name = (await readdir(destination)).find((entry) => entry.endsWith(".tgz"));
  if (!name) throw new Error(`pnpm pack produced no tarball for ${directory}.`);
  const path = join(destination, name);
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(packageRoot, "calavera-artifact.json"), "utf8"));
  assert.equal(manifest.id, directory, `${directory} manifest id must match its directory`);
  return {
    id: manifest.id,
    packageName: packageJson.name,
    version: packageJson.version,
    path,
    integrity: `sha512-${createHash("sha512")
      .update(await readFile(path))
      .digest("base64")}`,
  };
}

/**
 * Asserts that the project in the current directory locks exactly `ids` at their packed versions and
 * that every installed output matches its package-store payload.
 *
 * @param {string[]} ids
 */
async function assertInstalledFromPack(ids) {
  const lock = JSON.parse(await readFile(".calavera/artifacts.lock.json", "utf8"));
  assert.deepEqual(lock.artifacts.map(({ id }) => id).sort(), [...ids].sort());
  for (const id of ids) {
    const packed = packedArtifacts.get(id);
    const artifact = artifactForId(id);
    const entry = lock.artifacts.find((candidate) => candidate.id === id);
    assert.equal(entry.package, packed.packageName, id);
    assert.equal(entry.version, packed.version, id);
    assert.equal(entry.integrity, packed.integrity, id);
    assert.equal(
      await hashArtifactPayload(join(".calavera", "packages", id, entry.version, artifact.payload)),
      entry.payloadHash,
      `${id} locked payload hash`,
    );
    // Installation copies the payload verbatim for the default target: a skill directory as is,
    // a hook as hook.mjs plus its settings fragment, an agent as one file. Compare every installed
    // output against the package-store payload, not just its existence.
    const storePayload = join(".calavera", "packages", id, entry.version, artifact.payload);
    const outputs = aiArtifactOutputPaths({ type: entry.type, path: entry.destination });
    const expected =
      entry.type === "hook"
        ? [
            [outputs[0], join(storePayload, "hook.mjs")],
            [outputs[1], join(storePayload, "settings-fragment.json")],
          ]
        : [[outputs[0], storePayload]];
    assert.equal(expected.length, outputs.length, `${id} covers every installed output`);
    for (const [installed, source] of expected) {
      assert.equal(
        await hashArtifactPayload(installed),
        await hashArtifactPayload(source),
        `${id} installed ${installed} matches its payload`,
      );
    }
  }
}

/** @param {string} name @param {string[]} ids */
async function installInFixture(name, ids) {
  const projectDirectory = join(workRoot, "projects", name);
  await mkdir(projectDirectory, { recursive: true });
  const originalDirectory = process.cwd();
  try {
    process.chdir(projectDirectory);
    const recipe = buildRecipe(
      "minimal",
      [],
      "npm",
      aiArtifactRecipeItems(ids.map((id) => ({ id }))),
    );
    await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      { resolve: resolvePackedArtifact },
    );

    await assertInstalledFromPack(ids);
  } finally {
    process.chdir(originalDirectory);
  }
}

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "calavera-release-integration-"));
  const packed = await Promise.all((await artifactDirectories()).map(packArtifact));
  for (const { id, ...details } of packed) packedArtifacts.set(id, details);
  process.env.CALAVERA_PACKED_ARTIFACTS = JSON.stringify(Object.fromEntries(packedArtifacts));
});

after(async () => {
  delete process.env.CALAVERA_PACKED_ARTIFACTS;
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

test(`every workspace artifact installs from its packed tarball with CLI ${cliPackageJson.version}`, async (t) => {
  assert.ok(packedArtifacts.size > 0, "no workspace artifacts were packed");
  for (const id of packedArtifacts.keys()) {
    await t.test(id, () => installInFixture(id, [id]));
  }
});

test("all workspace artifacts install together into one project", async () => {
  await installInFixture("all-artifacts", [...packedArtifacts.keys()]);
});

test(`a Composer-built recipe passes the CLI ${cliPackageJson.version} guard, validation, and dry run`, async () => {
  const recipe = composerRecipe({
    profile: "minimal",
    packageManager: "npm",
    integrations: ["editorconfig", "html-validate"],
    aiArtifacts: [
      { id: "skill-release-with-confidence" },
      { id: "hook-block-dangerous-commands", target: "codex" },
    ],
  });
  assertPublishedCliCompatibility(recipe, cliPackageJson.version);
  assert.throws(
    () => assertPublishedCliCompatibility(recipe, "2.3.0"),
    /does not support these AI artifacts: skill-release-with-confidence\./,
  );

  const projectDirectory = join(workRoot, "projects", "composer-recipe");
  await mkdir(projectDirectory, { recursive: true });
  const originalDirectory = process.cwd();
  try {
    process.chdir(projectDirectory);
    await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      { resolve: resolvePackedArtifact },
    );

    validateRecipe(JSON.parse(await readFile("calavera.config.json", "utf8")));
    const response = await callMcpTool("dry_run_apply", { recipe });
    assert.equal(response.result.dryRun, true);
    assert.ok(response.result.changes.length > 0, "the dry run plans no changes");
  } finally {
    process.chdir(originalDirectory);
  }
});

/** The same Composer-built recipe the hosted Composer produces with artifacts selected. */
function composerRecipeWithArtifacts() {
  return composerRecipe({
    profile: "minimal",
    packageManager: "npm",
    integrations: ["editorconfig", "html-validate"],
    aiArtifacts: [
      { id: "skill-release-with-confidence" },
      { id: "hook-block-dangerous-commands", target: "codex" },
    ],
  });
}

/** @param {string} name */
async function freshProject(name) {
  const projectDirectory = join(workRoot, "projects", name);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    join(projectDirectory, "package.json"),
    `${JSON.stringify({ name, private: true, scripts: {} }, null, 2)}\n`,
  );
  return projectDirectory;
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a first apply of a Composer-built recipe with artifacts installs them through the CLI", async () => {
  const recipe = composerRecipeWithArtifacts();
  const ids = recipe.ai.map(({ id }) => id);
  const projectDirectory = await freshProject("composer-first-apply-cli");
  await writeFile(
    join(projectDirectory, "calavera.config.json"),
    `${JSON.stringify(recipe, null, 2)}\n`,
  );
  const before = await snapshotDirectory(projectDirectory);
  /** @param {string[]} args */
  const runCli = (args) =>
    execFileAsync(process.execPath, ["--import", packedRegistryPreload, cliPath, ...args], {
      cwd: projectDirectory,
      env: { ...process.env, NO_COLOR: "1" },
    });

  const preview = await runCli(["apply", "--dry-run"]);
  for (const id of ids) {
    const packed = packedArtifacts.get(id);
    assert.ok(packed);
    assert.match(
      preview.stdout,
      new RegExp(
        `Would resolve and lock artifact ${id} at ${escapeRegExp(`${packed.packageName}@${packed.version}`)}`,
      ),
    );
  }
  assert.deepEqual(await snapshotDirectory(projectDirectory), before, "the dry run wrote files");

  const applied = await runCli(["apply", "--yes", "--no-install"]);
  for (const id of ids) {
    assert.match(applied.stdout, new RegExp(`Resolved and locked artifact ${id} at `));
  }
  const originalDirectory = process.cwd();
  try {
    process.chdir(projectDirectory);
    await assertInstalledFromPack(ids);
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(packageJson.dependencies, undefined);
    assert.equal(packageJson.devDependencies, undefined);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("a first apply of a Composer-built recipe with artifacts installs them through the MCP tools", async () => {
  const recipe = composerRecipeWithArtifacts();
  const ids = recipe.ai.map(({ id }) => id);
  const projectDirectory = await freshProject("composer-first-apply-mcp");
  const originalDirectory = process.cwd();
  try {
    process.chdir(projectDirectory);
    const before = await snapshotDirectory();

    const preview = await callMcpTool(
      "dry_run_apply",
      { recipe },
      { resolve: resolvePackedArtifact },
    );
    assert.deepEqual(
      preview.result.autoInstalledArtifacts.map(({ id, version }) => ({ id, version })),
      ids.map((id) => ({ id, version: packedArtifacts.get(id)?.version })),
    );
    assert.deepEqual(await snapshotDirectory(), before, "dry_run_apply wrote files");

    const applied = await callMcpTool(
      "apply_recipe",
      { recipe, noInstall: true },
      { resolve: resolvePackedArtifact },
    );
    assert.deepEqual(
      applied.result.autoInstalledArtifacts.map(({ id }) => id),
      ids,
    );
    await assertInstalledFromPack(ids);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("init --apply lists the artifacts it would lock in its approval summary", async () => {
  const id = "skill-release-with-confidence";
  const packed = packedArtifacts.get(id);
  assert.ok(packed);
  const projectDirectory = await freshProject("init-apply-summary");
  const before = await snapshotDirectory(projectDirectory);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      packedRegistryPreload,
      cliPath,
      "init",
      "--apply",
      "--dry-run",
      "--yes",
      "--profile",
      "minimal",
      "--package-manager",
      "npm",
      "--ai-artifact",
      id,
    ],
    { cwd: projectDirectory, env: { ...process.env, NO_COLOR: "1" } },
  );

  // The summary is drawn in a box that wraps long lines; compare its text without the frame. A
  // FORCE_COLOR in the caller's environment overrides NO_COLOR, so strip escape sequences too.
  const summary = stripVTControlCharacters(stdout)
    .replace(/[│├╮╯─◇]/g, " ")
    .replace(/\s+/g, " ");
  assert.match(
    summary,
    new RegExp(
      `Artifacts to lock: ${id} \\(${escapeRegExp(`${packed.packageName}@${packed.version}`)}\\)`,
    ),
  );
  assert.deepEqual(await snapshotDirectory(projectDirectory), before, "init --dry-run wrote files");
});
