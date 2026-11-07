// Drift test for the supported Node.js range (#792). `engines.node` of the CLI
// must be at least as narrow as the `engines.node` of every package that
// `npm install create-project-calavera` puts on disk. Without this test, a
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
import assert from "node:assert/strict";
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
 * dependencies and exists only in `snapshots`. An alias reference such as
 * `npm:real-name@1.0.0` points at the real package.
 *
 * @param {string} name
 * @param {string} reference
 */
function lockfileKeys(name, reference) {
  const snapshotKey = reference.startsWith("npm:")
    ? reference.slice("npm:".length)
    : `${name}@${reference}`;

  return { snapshotKey, packageKey: snapshotKey.replace(/\(.*$/u, "") };
}

/**
 * Walks the production dependency tree of an importer in a parsed
 * `pnpm-lock.yaml`.
 *
 * @param {any} lockfile
 * @param {string} rootImporter Importer path, such as `packages/cli`.
 * @returns {Map<string, { engines: string | undefined, path: string[] }>}
 *   Package key (`name@version`) to its declared `engines.node` and the first
 *   chain of dependencies that reaches it from the root.
 */
function productionTree(lockfile, rootImporter) {
  /** @type {Map<string, { engines: string | undefined, path: string[] }>} */
  const found = new Map();
  const seenImporters = new Set();
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
          enqueueImporter(
            posix.normalize(posix.join(importerPath, version.slice("link:".length))),
            [...path, name],
          );
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

    if (found.has(packageKey)) {
      continue;
    }

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

    found.set(packageKey, { engines: metadata.engines?.node, path });

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

const lockfile = parse(await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"));
const tree = productionTree(lockfile, CLI_IMPORTER);

test("the production tree reaches the direct and the transitive dependencies of the CLI", () => {
  const names = new Set([...tree.keys()].map((key) => key.slice(0, key.lastIndexOf("@"))));

  // A direct dependency of the CLI itself.
  assert.ok(names.has("zod"));
  // A direct dependency of a workspace package, reached through `link:`.
  assert.ok(names.has("pacote"));
  // A dependency of a dependency, so the walk is not one level deep.
  assert.ok([...tree.values()].some(({ path }) => path.length > 2));
  // Development dependencies of the repository are not part of the tree.
  assert.equal(names.has("stryker-mutator"), false);
  assert.equal(names.has("@stryker-mutator/core"), false);
});

test("the walk handles links, aliases, peer suffixes, optional dependencies, and cycles", () => {
  const synthetic = {
    importers: {
      "packages/app": {
        dependencies: {
          lib: { version: "link:../lib" },
          peered: { version: "1.0.0(peer@2.0.0)" },
          aliased: { version: "npm:real@3.0.0" },
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
    "optional@1.0.0",
    "peer@2.0.0",
    "peered@1.0.0",
    "real@3.0.0",
  ]);
  assert.deepEqual(engineViolations(walked, "20.0.0"), [
    "real@3.0.0 requires Node.js >=22 (reached through aliased)",
  ]);
  assert.deepEqual(engineViolations(walked, "22.0.0"), []);
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
