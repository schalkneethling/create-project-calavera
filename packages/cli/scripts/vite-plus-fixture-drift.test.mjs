// Issue #433: the ADR-0001 signals in the committed `vp create` output must
// match what vite-plus-fixtures.mjs synthesizes, so a vite-plus release that
// moves or renames a signal fails here instead of silently leaving the
// hand-written fixtures describing an older release.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYAML } from "yaml";

import { detectVitePlus } from "../src/vite-plus-detection.js";
import {
  libraryManifest,
  monorepoRootManifest,
  pnpmWorkspaceCatalog,
  releaseFixturePath,
  vitePlusConfig,
  vitePlusFixtureRelease,
} from "./vite-plus-fixtures.mjs";

const library = releaseFixturePath("library");
const monorepo = releaseFixturePath("monorepo");
const monorepoMember = join(monorepo, "packages", "utils");

/** @param {string} path */
async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {string} path */
async function readYAML(path) {
  return parseYAML(await readFile(path, "utf8"));
}

/**
 * The module `defineConfig` is imported from.
 *
 * @param {string} source
 */
function defineConfigSource(source) {
  return /import\s*\{\s*defineConfig\s*\}\s*from\s*["']([^"']+)["']/.exec(source)?.[1];
}

/**
 * Splits a pin such as `npm:@voidzero-dev/vite-plus-core@1.0.0` into the
 * aliased package and its version.
 *
 * @param {unknown} pin
 */
function aliasedPackage(pin) {
  const match = typeof pin === "string" ? /^npm:(@[^@]+)@(.+)$/.exec(pin) : null;
  return match ? { name: match[1], version: match[2] } : undefined;
}

/** @param {Record<string, unknown>} manifest */
function vitePlusDependencySections(manifest) {
  return ["dependencies", "devDependencies", "peerDependencies"].filter((section) =>
    Object.hasOwn(manifest[section] ?? {}, "vite-plus"),
  );
}

test("the vite-plus dependency is declared in the section the synthetic fixtures use", async () => {
  const expected = vitePlusDependencySections(libraryManifest);
  assert.deepEqual(expected, ["devDependencies"]);
  assert.deepEqual(vitePlusDependencySections(monorepoRootManifest), expected);

  for (const path of [library, monorepo, monorepoMember]) {
    assert.deepEqual(
      vitePlusDependencySections(await readJSON(join(path, "package.json"))),
      expected,
      path,
    );
  }
});

test("vite.config.ts imports defineConfig from vite-plus, as the synthetic configuration does", async () => {
  const expected = defineConfigSource(vitePlusConfig);
  assert.equal(expected, "vite-plus");

  for (const path of [library, monorepo, monorepoMember]) {
    assert.equal(
      defineConfigSource(await readFile(join(path, "vite.config.ts"), "utf8")),
      expected,
      path,
    );
  }
});

test("the vite pin aliases the package the synthetic fixtures pin, through the same pnpm catalog override", async () => {
  const syntheticCatalog = parseYAML(pnpmWorkspaceCatalog);
  const expectedPackage = aliasedPackage(syntheticCatalog.catalog.vite)?.name;
  assert.equal(expectedPackage, "@voidzero-dev/vite-plus-core");
  assert.equal(aliasedPackage(libraryManifest.overrides.vite)?.name, expectedPackage);
  assert.equal(aliasedPackage(monorepoRootManifest.overrides.vite)?.name, expectedPackage);

  for (const path of [library, monorepo]) {
    const workspace = await readYAML(join(path, "pnpm-workspace.yaml"));

    assert.deepEqual(
      aliasedPackage(workspace.catalog.vite),
      { name: expectedPackage, version: vitePlusFixtureRelease },
      path,
    );
    assert.equal(workspace.catalog["vite-plus"], vitePlusFixtureRelease, path);
    assert.deepEqual(workspace.overrides, syntheticCatalog.overrides, path);
  }
});

test("the monorepo workspace globs match the synthetic monorepo", async () => {
  const workspace = await readYAML(join(monorepo, "pnpm-workspace.yaml"));

  assert.deepEqual([...workspace.packages].sort(), [...monorepoRootManifest.workspaces].sort());
});

test("detectVitePlus reads the committed fixtures as it reads the synthetic ones", async () => {
  const allSignals = ["vite-plus-config-import", "vite-plus-core-pin", "vp-scripts"];

  for (const path of [library, monorepo]) {
    assert.deepEqual(
      await detectVitePlus(path),
      {
        status: "managed",
        signal: "vite-plus-dependency",
        manifestPath: "package.json",
        corroborating: allSignals,
      },
      path,
    );
  }

  assert.deepEqual(await detectVitePlus(monorepoMember), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vite-plus-config-import", "vp-scripts"],
  });
  assert.deepEqual(await detectVitePlus(join(monorepo, "apps", "website")), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vp-scripts"],
  });
});
