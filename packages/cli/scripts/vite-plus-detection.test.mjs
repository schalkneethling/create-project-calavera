import assert from "node:assert/strict";
import { mkdir, mkdtempDisposable, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { detectVitePlus } from "../src/vite-plus-detection.js";

/**
 * Builds a fixture tree in a fresh temporary directory.
 *
 * @param {string} label
 * @param {Record<string, string>} files
 * @returns {Promise<string>} the canonical absolute path of the fixture root
 */
/**
 * Builds a fixture in a disposable temporary directory. `root` is the resolved
 * path, so absolute manifest paths compare equal on platforms where the
 * temporary root is a symlink. Use with `await using` so the directory is
 * removed when the test scope ends.
 *
 * @param {string} label
 * @param {Record<string, string>} files
 */
async function createFixture(label, files) {
  const directory = await mkdtempDisposable(join(tmpdir(), `calavera-vite-plus-${label}-`));
  const root = await realpath(directory.path);

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return {
    root,
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
}

/** @param {unknown} value */
function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const vitePlusConfig = `import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: { options: { typeAware: true } },
  fmt: {},
});
`;

const plainViteConfig = `import { defineConfig } from "vite";

export default defineConfig({});
`;

const pnpmWorkspaceCatalog = `catalog:
  vite: npm:@voidzero-dev/vite-plus-core@0.3.1
  vite-plus: 0.3.1
overrides:
  vite@*: "catalog:"
`;

const yarnrcCatalog = `nodeLinker: node-modules
catalog:
  vite: npm:@voidzero-dev/vite-plus-core@0.3.1
  vite-plus: 0.3.1
`;

const libraryManifest = {
  name: "gen-library",
  version: "0.0.0",
  type: "module",
  scripts: { dev: "vp dev", build: "vp build", check: "vp check" },
  devDependencies: { typescript: "^7.0.2", "vite-plus": "^0.2.4" },
  overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.3.1" },
};

const plainViteManifest = {
  name: "plain-vite",
  version: "0.0.0",
  type: "module",
  scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
  devDependencies: { typescript: "~6.0.2", vite: "^7.2.0" },
};

const monorepoRootManifest = {
  name: "gen-monorepo",
  version: "0.0.0",
  private: true,
  workspaces: ["packages/*", "apps/*", "tools/*"],
  type: "module",
  scripts: { ready: "vp check && vp run -r test", dev: "vp run website#dev" },
  devDependencies: { "vite-plus": "0.3.1" },
  overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.3.1" },
};

/**
 * Lists every entry under a directory with its modification time, so that a
 * detection run can be shown to leave the tree untouched.
 *
 * @param {string} root
 * @returns {Promise<Array<[string, number]>>}
 */
async function listTree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const listing = [];

  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const stats = await stat(path);
    listing.push([path, stats.mtimeMs]);
  }

  return listing.sort(([left], [right]) => left.localeCompare(right));
}

/** @param {string} directory */
async function hasAncestorManifest(directory) {
  let current = directory;

  while (true) {
    try {
      await stat(join(current, "package.json"));
      return true;
    } catch {
      // No manifest at this level.
    }

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }

    current = parent;
  }
}

test("vp create vite:library", async () => {
  await using fixture = await createFixture("library", {
    "package.json": json(libraryManifest),
    "vite.config.ts": vitePlusConfig,
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vite-plus-config-import", "vite-plus-core-pin", "vp-scripts"],
  });
});

test("vp create vite:monorepo root", async () => {
  await using fixture = await createFixture("monorepo-root", {
    "package.json": json(monorepoRootManifest),
    "vite.config.ts": vitePlusConfig,
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vite-plus-config-import", "vite-plus-core-pin", "vp-scripts"],
  });
});

test("monorepo workspace member with a local declaration", async () => {
  await using fixture = await createFixture("member-local", {
    "package.json": json(monorepoRootManifest),
    "vite.config.ts": vitePlusConfig,
    "apps/website/package.json": json({
      name: "website",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: { dev: "vp dev", build: "tsc && vp build", preview: "vp preview" },
      devDependencies: { typescript: "^7.0.2", "vite-plus": "0.3.1" },
    }),
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(join(root, "apps", "website")), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vp-scripts"],
  });
});

test("monorepo workspace member without a local declaration", async () => {
  await using fixture = await createFixture("member-inherited", {
    "package.json": json(monorepoRootManifest),
    "apps/site/package.json": json({
      name: "site",
      version: "0.0.0",
      private: true,
      type: "module",
      devDependencies: { typescript: "^7.0.2" },
    }),
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(join(root, "apps", "site")), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: join(root, "package.json"),
    corroborating: ["vite-plus-core-pin"],
  });
});

test("vp migrate output with a stale lockfile", async () => {
  await using fixture = await createFixture("migrated", {
    "package.json": json({
      name: "migrated",
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vp dev", build: "tsc && vp build", prepare: "vp config" },
      devDependencies: { typescript: "~6.0.2", vite: "catalog:", "vite-plus": "catalog:" },
    }),
    "vite.config.ts": vitePlusConfig,
    "pnpm-workspace.yaml": pnpmWorkspaceCatalog,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "package-lock.json": json({ name: "migrated", lockfileVersion: 3 }),
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vite-plus-config-import", "vite-plus-core-pin", "vp-scripts"],
  });
});

test("plain create-vite project", async () => {
  await using fixture = await createFixture("plain-vite", {
    "package.json": json(plainViteManifest),
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "unmanaged",
    corroborating: [],
  });
});

test("plain Vite with a hand-written configuration", async () => {
  await using fixture = await createFixture("plain-vite-config", {
    "package.json": json(plainViteManifest),
    "vite.config.ts": plainViteConfig,
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "unmanaged",
    corroborating: [],
  });
});

test("vite-plus as a peerDependency only", async () => {
  await using fixture = await createFixture("peer-only", {
    "package.json": json({
      name: "vite-plus-plugin",
      version: "0.0.0",
      type: "module",
      peerDependencies: { "vite-plus": "^0.3.0" },
    }),
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "unmanaged",
    corroborating: [],
  });
});

test("vp named only in prose", async () => {
  await using fixture = await createFixture("prose-only", {
    "package.json": json(plainViteManifest),
    "AGENTS.md": "# Agents\n\nRun `vp check` before every commit.\n",
    "README.md": "# Project\n\nThis project uses `vp build` one day.\n",
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "unmanaged",
    corroborating: [],
  });
});

test("scripts call vp, dependency absent", async () => {
  await using fixture = await createFixture("scripts-only", {
    "package.json": json({
      name: "scripts-only",
      version: "0.0.0",
      type: "module",
      scripts: { build: "vp build" },
      devDependencies: { typescript: "~6.0.2" },
    }),
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "unmanaged",
    corroborating: ["vp-scripts"],
  });
});

test("pin present, dependency absent", async () => {
  await using fixture = await createFixture("pin-only", {
    "package.json": json({
      name: "pin-only",
      version: "0.0.0",
      type: "module",
      scripts: { build: "vite build" },
      overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.3.1" },
    }),
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "unmanaged",
    corroborating: ["vite-plus-core-pin"],
  });
});

test("vp create vite:library with Yarn", async () => {
  await using fixture = await createFixture("yarn-library", {
    "package.json": json({
      name: "gen-library",
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vp dev", build: "vp build" },
      devDependencies: { typescript: "^7.0.2", "vite-plus": "catalog:" },
      resolutions: { vite: "npm:@voidzero-dev/vite-plus-core@0.3.1" },
    }),
    ".yarnrc.yml": yarnrcCatalog,
    "vite.config.ts": vitePlusConfig,
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vite-plus-config-import", "vite-plus-core-pin", "vp-scripts"],
  });
});

test("vp create vite:library with Bun", async () => {
  await using fixture = await createFixture("bun-library", {
    "package.json": json({
      name: "gen-library",
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vp dev", build: "vp build" },
      devDependencies: {
        typescript: "^7.0.2",
        vite: "npm:@voidzero-dev/vite-plus-core@0.3.1",
        "vite-plus": "^0.2.4",
      },
      overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.3.1" },
    }),
    "vite.config.ts": vitePlusConfig,
  });
  const root = fixture.root;

  assert.deepEqual(await detectVitePlus(root), {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: ["vite-plus-config-import", "vite-plus-core-pin", "vp-scripts"],
  });
});

test("no package.json, no ancestor manifest", async (t) => {
  await using fixture = await createFixture("no-ancestor", {});
  const root = fixture.root;

  if (await hasAncestorManifest(dirname(root))) {
    t.skip(
      `An ancestor of ${root} contains a package.json, so this environment cannot host the fixture.`,
    );
    return;
  }

  assert.deepEqual(await detectVitePlus(root), {
    status: "unknown",
    corroborating: [],
  });
});

test("no package.json, managed ancestor", async () => {
  await using fixture = await createFixture("managed-ancestor", {
    "package.json": json(libraryManifest),
    "vite.config.ts": vitePlusConfig,
  });
  const root = fixture.root;
  const child = join(root, "src", "empty");
  await mkdir(child, { recursive: true });

  assert.deepEqual(await detectVitePlus(child), {
    status: "unknown",
    corroborating: [],
    ancestor: { manifestPath: join(root, "package.json"), status: "managed" },
  });
});

test("no package.json, unmanaged ancestor", async () => {
  await using fixture = await createFixture("unmanaged-ancestor", {
    "package.json": json(plainViteManifest),
  });
  const root = fixture.root;
  const child = join(root, "src", "empty");
  await mkdir(child, { recursive: true });

  assert.deepEqual(await detectVitePlus(child), {
    status: "unknown",
    corroborating: [],
    ancestor: { manifestPath: join(root, "package.json"), status: "unmanaged" },
  });
});

test("unparseable package.json", async () => {
  await using fixture = await createFixture("unparseable", {
    "package.json": "{",
  });
  const root = fixture.root;

  const detection = await detectVitePlus(root);

  assert.equal(detection.status, "unknown");
  assert.deepEqual(detection.corroborating, []);
  assert.equal(Object.hasOwn(detection, "signal"), false);
  assert.equal(Object.hasOwn(detection, "manifestPath"), false);
});

test("package.json that parses to an array", async () => {
  await using fixture = await createFixture("array-manifest", {
    "package.json": "[]",
  });
  const root = fixture.root;

  const detection = await detectVitePlus(root);

  assert.equal(detection.status, "unknown");
  assert.deepEqual(detection.corroborating, []);
  assert.equal(Object.hasOwn(detection, "signal"), false);
  assert.equal(Object.hasOwn(detection, "manifestPath"), false);
});

test("detection does not search ancestors for a configuration file", async () => {
  await using fixture = await createFixture("config-not-inherited", {
    "package.json": json(monorepoRootManifest),
    "vite.config.ts": vitePlusConfig,
    "apps/api/package.json": json({
      name: "api",
      version: "0.0.0",
      type: "module",
      devDependencies: { "vite-plus": "0.3.1" },
    }),
  });
  const root = fixture.root;

  const detection = await detectVitePlus(join(root, "apps", "api"));

  assert.equal(detection.status, "managed");
  assert.equal(detection.corroborating.includes("vite-plus-config-import"), false);
  assert.deepEqual(detection.corroborating, []);
});

test("detection writes nothing into the inspected tree", async () => {
  await using fixture = await createFixture("purity", {
    "package.json": json(libraryManifest),
    "vite.config.ts": vitePlusConfig,
    "pnpm-workspace.yaml": pnpmWorkspaceCatalog,
    "src/main.ts": "export const answer = 42;\n",
  });
  const root = fixture.root;

  const before = await listTree(root);
  await detectVitePlus(root);
  const after = await listTree(root);

  assert.deepEqual(after, before);
});
