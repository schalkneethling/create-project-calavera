import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { hashArtifactPayload } from "@schalkneethling/calavera-artifact-core/registry";
import cliPackageJson from "../package.json" with { type: "json" };

import {
  assertPublishedCliCompatibility,
  composerRecipe,
} from "../../../apps/composer/recipe-builder.js";
import { aiArtifactOutputPaths } from "../src/ai/artifacts.js";
import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { callMcpTool } from "../src/mcp.js";
import { aiArtifactRecipeItems, buildRecipe, validateRecipe } from "../src/recipe.js";

const execFileAsync = promisify(execFile);
const artifactPackagesRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));

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
 * Stands in for the npm registry only: it answers with the packed workspace tarball. The real
 * extractArtifactPackage then verifies integrity, package identity, the manifest, compatibility
 * with the workspace CLI version, and the payload.
 * @param {{ id: string, tag?: "latest" | "next", version?: string, cache: string }} request
 */
async function resolvePackedArtifact(request) {
  const artifact = artifactForId(request.id);
  const packed = packedArtifacts.get(request.id);
  assert.ok(artifact && packed, `No packed workspace artifact for ${request.id}`);
  // The real resolver requests artifact.packageName from npm, so a package.json whose name drifts
  // from the catalog would fail there; the fixture must not paper over that.
  assert.equal(
    packed.packageName,
    artifact.packageName,
    `${request.id} package.json name must match the catalog package name`,
  );
  return {
    artifact,
    packageName: packed.packageName,
    version: request.version ?? packed.version,
    resolved: packed.path,
    integrity: packed.integrity,
    tag: request.tag ?? "latest",
    cache: request.cache,
    offline: false,
  };
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
        await hashArtifactPayload(
          join(".calavera", "packages", id, entry.version, artifact.payload),
        ),
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
  } finally {
    process.chdir(originalDirectory);
  }
}

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "calavera-release-integration-"));
  const packed = await Promise.all((await artifactDirectories()).map(packArtifact));
  for (const { id, ...details } of packed) packedArtifacts.set(id, details);
});

after(async () => {
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
