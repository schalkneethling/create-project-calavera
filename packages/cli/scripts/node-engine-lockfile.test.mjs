// Drift test for the supported Node.js range (#792). `engines.node` of the CLI
// must be at least as narrow as the `engines.node` of every package in the
// locked production dependency tree of the CLI. Without this test, a
// dependency update that raises its floor passes CI, because pnpm only warns
// about an engine mismatch unless `engine-strict` is set (see #789, where
// pacote 22 required a later Node.js than the CLI declared).
//
// The packages checked are the production dependency tree of the published
// CLI, computed from `pnpm-lock.yaml`: the CLI's `dependencies`, followed
// through each package's `dependencies` and `optionalDependencies` in the
// lockfile's `snapshots`. A workspace dependency (`link:`) is followed into its
// own importer, because the published CLI installs it as a regular package.
// Development dependencies of the repository are not checked, because users do
// not install them.
//
// Limit: the published CLI ships without a lockfile, so a user's install
// resolves each range afresh and can pick a newer release than the locked one.
// This test checks the locked versions only; it cannot see a floating release
// that raises its floor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import test from "node:test";

import semver from "semver";
import { parse } from "yaml";

import { NODE_ENGINE_RANGE } from "../src/node-engine.js";

const CLI_IMPORTER = "packages/cli";

/**
 * The lowest version that each comparator set of a range allows, one per
 * supported line. `^24.15.0 || >=26.0.0` gives 24.15.0 and 26.0.0.
 *
 * @param {string} range
 * @returns {string[]}
 */
function lowestVersionPerLine(range) {
  return new semver.Range(range).set.map((comparators) => {
    const line = new semver.Range(comparators.map((comparator) => comparator.value).join(" "));

    return /** @type {semver.SemVer} */ (semver.minVersion(line)).version;
  });
}

/**
 * Splits a lockfile reference such as `1.32.2(supports-color@10.2.2)(zod@4.6.7)`
 * into the key of its entry in `packages` (`name@1.32.2`) and in `snapshots`
 * (the whole reference). The parenthesized part records resolved peer
 * dependencies and exists only in `snapshots`. An alias reference, which pnpm
 * writes as the real package's `real-name@1.0.0` instead of a bare version,
 * points at the real package.
 *
 * @param {string} name
 * @param {string} reference
 */
function lockfileKeys(name, reference) {
  const snapshotKey = /^\d/u.test(reference) ? `${name}@${reference}` : reference;

  return { snapshotKey, packageKey: snapshotKey.replace(/\(.*$/u, "") };
}

/**
 * The key under which `productionTree` records a dependency of an importer:
 * `name@workspace:<directory>` for a `link:` reference, otherwise the package
 * key (`name@version`) of the resolved package, which for an alias is the real
 * package's name.
 *
 * @param {string} importerPath
 * @param {string} name
 * @param {string} version The importer's `version` field from the lockfile.
 */
function importerDependencyKey(importerPath, name, version) {
  if (version.startsWith("link:")) {
    const linked = posix.normalize(posix.join(importerPath, version.slice("link:".length)));

    return `${name}@workspace:${linked}`;
  }

  return lockfileKeys(name, version).packageKey;
}

/**
 * Walks the production dependency tree of an importer in a parsed
 * `pnpm-lock.yaml`.
 *
 * @param {any} lockfile
 * @param {string} rootImporter Importer path, such as `packages/cli`.
 * @param {(importerPath: string) => string | undefined} [readWorkspaceEngines]
 *   Reads `engines.node` from the `package.json` of a workspace package that
 *   the tree links to; the lockfile does not record it.
 * @returns {Map<string, { engines: string | undefined, path: string[] }>}
 *   Package key (`name@version`) to its declared `engines.node` and the first
 *   chain of dependencies that reaches it from the root.
 */
function productionTree(lockfile, rootImporter, readWorkspaceEngines = () => undefined) {
  /** @type {Map<string, { engines: string | undefined, path: string[] }>} */
  const found = new Map();
  const seenImporters = new Set();
  // Visited by snapshot key, not package key: two snapshots of one version
  // that resolve different peers can have different dependencies, and each
  // must be walked.
  const seenSnapshots = new Set();
  /** @type {{ name: string, reference: string, path: string[] }[]} */
  const queue = [];

  /** @param {string} importerPath @param {string[]} path */
  const enqueueImporter = (importerPath, path) => {
    if (seenImporters.has(importerPath)) {
      return;
    }
    seenImporters.add(importerPath);
    const importer = lockfile.importers[importerPath];
    assert.ok(importer, `pnpm-lock.yaml has no importer "${importerPath}"`);

    // The `dependencies` and `optionalDependencies` of an importer are what its
    // published package installs; `devDependencies` are not.
    for (const group of [importer.dependencies, importer.optionalDependencies]) {
      for (const [name, { version }] of Object.entries(group ?? {})) {
        if (version.startsWith("link:")) {
          const key = importerDependencyKey(importerPath, name, version);
          const linked = key.slice(key.indexOf("@workspace:") + "@workspace:".length);

          // The published CLI installs the workspace package itself, so its own
          // `engines.node` counts too.
          found.set(key, { engines: readWorkspaceEngines(linked), path: [...path, name] });
          enqueueImporter(linked, [...path, name]);
        } else {
          queue.push({ name, reference: version, path: [...path, name] });
        }
      }
    }
  };

  enqueueImporter(rootImporter, []);

  while (queue.length > 0) {
    const { name, reference, path } = /** @type {NonNullable<(typeof queue)[number]>} */ (
      queue.shift()
    );
    const { snapshotKey, packageKey } = lockfileKeys(name, reference);

    if (seenSnapshots.has(snapshotKey)) {
      continue;
    }
    seenSnapshots.add(snapshotKey);

    const metadata = lockfile.packages[packageKey];
    const snapshot = lockfile.snapshots[snapshotKey];
    assert.ok(
      metadata,
      `pnpm-lock.yaml has no \`packages\` entry for ${packageKey} (${path.join(" > ")})`,
    );
    assert.ok(
      snapshot,
      `pnpm-lock.yaml has no \`snapshots\` entry for ${snapshotKey} (${path.join(" > ")})`,
    );

    // Keep the first chain that reaches the package; a later snapshot of the
    // same version has the same `engines.node`.
    if (!found.has(packageKey)) {
      found.set(packageKey, { engines: metadata.engines?.node, path });
    }

    for (const group of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [dependencyName, dependencyReference] of Object.entries(group ?? {})) {
        queue.push({
          name: dependencyName,
          reference: dependencyReference,
          path: [...path, dependencyName],
        });
      }
    }
  }

  return found;
}

/**
 * Every package in the tree whose `engines.node` rejects `version`, as a
 * message that names the package, its range, and how the CLI reaches it.
 *
 * @param {ReturnType<typeof productionTree>} tree
 * @param {string} version
 * @returns {string[]}
 */
function engineViolations(tree, version) {
  const violations = [];

  for (const [packageKey, { engines, path }] of tree) {
    if (engines === undefined) {
      continue;
    }
    assert.ok(
      semver.validRange(engines),
      `${packageKey} declares an engines.node that semver cannot parse: ${engines}`,
    );
    if (!semver.satisfies(version, engines)) {
      violations.push(
        `${packageKey} requires Node.js ${engines} (reached through ${path.join(" > ")})`,
      );
    }
  }

  return violations;
}

/**
 * The dependencies that an importer's manifest declares but the tree does not
 * contain. Each is matched through the importer's resolved reference in the
 * lockfile, so an alias (`"aliased": "npm:real@^3"`) is found under the real
 * package and a `workspace:` dependency under its linked directory.
 *
 * @param {any} lockfile
 * @param {ReturnType<typeof productionTree>} tree
 * @param {string} importerPath
 * @param {{ dependencies?: Record<string, string> }} manifest
 * @returns {string[]}
 */
function declaredDependenciesMissingFromTree(lockfile, tree, importerPath, manifest) {
  const resolved = lockfile.importers[importerPath]?.dependencies ?? {};

  return Object.keys(manifest.dependencies ?? {}).filter((name) => {
    const entry = resolved[name];

    return !entry || !tree.has(importerDependencyKey(importerPath, name, entry.version));
  });
}

const repositoryRoot = new URL("../../../", import.meta.url);
const lockfile = parse(await readFile(new URL("pnpm-lock.yaml", repositoryRoot), "utf8"));
const tree = productionTree(lockfile, CLI_IMPORTER, (importerPath) => {
  const manifest = JSON.parse(
    readFileSync(new URL(`${importerPath}/package.json`, repositoryRoot), "utf8"),
  );

  return manifest.engines?.node;
});

test("the production tree contains every dependency that a published manifest declares", () => {
  const workspaceDirectories = [...tree.keys()]
    .filter((key) => key.includes("@workspace:"))
    .map((key) => key.slice(key.indexOf("@workspace:") + "@workspace:".length));

  // `packages/cli` plus the workspace packages it links to (artifact-core and
  // baseline-core at the time of writing).
  assert.ok(workspaceDirectories.length > 0);
  for (const directory of [CLI_IMPORTER, ...workspaceDirectories]) {
    const manifest = JSON.parse(
      readFileSync(new URL(`${directory}/package.json`, repositoryRoot), "utf8"),
    );

    assert.deepEqual(
      declaredDependenciesMissingFromTree(lockfile, tree, directory, manifest),
      [],
      `dependencies of ${directory} are missing from the tree`,
    );
  }
  // A dependency of a dependency, so the walk is not one level deep.
  assert.ok([...tree.values()].some(({ path }) => path.length > 2));
});

test("the walk handles links, aliases, peer suffixes, optional dependencies, and cycles", () => {
  const synthetic = {
    importers: {
      "packages/app": {
        dependencies: {
          lib: { version: "link:../lib" },
          peered: { version: "1.0.0(peer@2.0.0)" },
          aliased: { version: "real@3.0.0" },
        },
        devDependencies: { devOnly: { version: "9.0.0" } },
      },
      "packages/lib": { dependencies: { cyclic: { version: "1.0.0" } } },
    },
    packages: {
      "peered@1.0.0": { engines: { node: ">=20" } },
      "real@3.0.0": { engines: { node: ">=22" } },
      "cyclic@1.0.0": { engines: { node: ">=18" } },
      "optional@1.0.0": {},
      "peer@2.0.0": {},
    },
    snapshots: {
      "peered@1.0.0(peer@2.0.0)": { dependencies: { peer: "2.0.0" } },
      "peer@2.0.0": {},
      "real@3.0.0": { optionalDependencies: { optional: "1.0.0" } },
      "optional@1.0.0": {},
      "cyclic@1.0.0": { dependencies: { cyclic: "1.0.0" } },
    },
  };
  const walked = productionTree(synthetic, "packages/app");

  assert.deepEqual([...walked.keys()].sort(), [
    "cyclic@1.0.0",
    "lib@workspace:packages/lib",
    "optional@1.0.0",
    "peer@2.0.0",
    "peered@1.0.0",
    "real@3.0.0",
  ]);
  assert.deepEqual(engineViolations(walked, "20.0.0"), [
    "real@3.0.0 requires Node.js >=22 (reached through aliased)",
  ]);
  assert.deepEqual(engineViolations(walked, "22.0.0"), []);

  // A linked workspace package reports its own engines.node from its manifest.
  const withWorkspaceEngines = productionTree(synthetic, "packages/app", () => ">=30");

  assert.deepEqual(engineViolations(withWorkspaceEngines, "30.0.0"), []);
  assert.deepEqual(engineViolations(withWorkspaceEngines, "22.0.0"), [
    "lib@workspace:packages/lib requires Node.js >=30 (reached through lib)",
  ]);

  // Declared dependencies are matched through the lockfile, so the alias is
  // found under `real` and the workspace dependency under its directory.
  assert.deepEqual(
    declaredDependenciesMissingFromTree(synthetic, walked, "packages/app", {
      dependencies: { lib: "workspace:*", peered: "^1.0.0", aliased: "npm:real@^3.0.0" },
    }),
    [],
  );
  assert.deepEqual(
    declaredDependenciesMissingFromTree(synthetic, walked, "packages/app", {
      dependencies: { absent: "^1.0.0" },
    }),
    ["absent"],
  );
});

test("two snapshots of one version with different peers are both walked", () => {
  const synthetic = {
    importers: {
      "packages/app": {
        dependencies: {
          first: { version: "1.0.0" },
          second: { version: "1.0.0" },
        },
      },
    },
    packages: {
      "first@1.0.0": {},
      "second@1.0.0": {},
      "shared@1.0.0": {},
      "peer@1.0.0": {},
      "peer@2.0.0": {},
      "only-with-peer-2@1.0.0": { engines: { node: ">=30" } },
    },
    snapshots: {
      "first@1.0.0": { dependencies: { shared: "1.0.0(peer@1.0.0)" } },
      "second@1.0.0": { dependencies: { shared: "1.0.0(peer@2.0.0)" } },
      "shared@1.0.0(peer@1.0.0)": { dependencies: { peer: "1.0.0" } },
      "shared@1.0.0(peer@2.0.0)": {
        dependencies: { peer: "2.0.0", "only-with-peer-2": "1.0.0" },
      },
      "peer@1.0.0": {},
      "peer@2.0.0": {},
      "only-with-peer-2@1.0.0": {},
    },
  };
  const walked = productionTree(synthetic, "packages/app");

  assert.deepEqual(engineViolations(walked, "24.0.0"), [
    "only-with-peer-2@1.0.0 requires Node.js >=30 (reached through second > shared > only-with-peer-2)",
  ]);
});

test("the lowest allowed version per supported line is found from the range", () => {
  assert.deepEqual(lowestVersionPerLine("^24.15.0 || >=26.0.0"), ["24.15.0", "26.0.0"]);
  assert.deepEqual(lowestVersionPerLine(">=20.19.0"), ["20.19.0"]);
});

test("every package the CLI installs accepts the lowest Node.js version of each supported line", () => {
  const versions = lowestVersionPerLine(NODE_ENGINE_RANGE);

  assert.ok(versions.length > 0, `no supported line found in ${NODE_ENGINE_RANGE}`);
  for (const version of versions) {
    const violations = engineViolations(tree, version);

    assert.equal(
      violations.length,
      0,
      `The CLI declares engines.node ${NODE_ENGINE_RANGE}, which allows Node.js ${version}, but these packages reject it: ${violations.join("; ")}. Raise the floor in packages/cli/package.json or hold the dependency back.`,
    );
  }
});
