// Shared ADR-0001 fixtures for the Vite+ detection tests and for the tests
// that drive detection through the MCP tools and the CLI.
import { cp, mkdir, mkdtempDisposable, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Writes `files` into a fresh directory under the OS temp dir. The directory
 * is removed when the returned fixture is disposed, so call sites use
 * `await using`.
 *
 * @param {string} label
 * @param {Record<string, string>} files
 */
export async function createTemporaryFixture(label, files) {
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

/** The vite-plus release the committed `vp create` fixtures were generated with. */
export const vitePlusFixtureRelease = "1.0.0";

/**
 * Absolute path of a committed `vp create` fixture. Read it; never apply to it.
 *
 * @param {"library" | "monorepo"} name
 */
export function releaseFixturePath(name) {
  return fileURLToPath(
    new URL(`../fixtures/vite-plus/${vitePlusFixtureRelease}/${name}`, import.meta.url),
  );
}

/**
 * Copies a committed `vp create` fixture into a disposable temporary directory,
 * so a test can apply to the copy without mutating the committed files.
 *
 * @param {"library" | "monorepo"} name
 */
export async function copyReleaseFixture(name) {
  const directory = await mkdtempDisposable(join(tmpdir(), `calavera-vite-plus-${name}-`));
  const root = await realpath(directory.path);
  await cp(releaseFixturePath(name), root, { recursive: true });

  return {
    root,
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
}

/** @param {unknown} value */
export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const vitePlusConfig = `import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: { options: { typeAware: true } },
  fmt: {},
});
`;

export const plainViteConfig = `import { defineConfig } from "vite";

export default defineConfig({});
`;

export const libraryManifest = {
  name: "gen-library",
  version: "0.0.0",
  type: "module",
  scripts: { dev: "vp dev", build: "vp build", check: "vp check" },
  devDependencies: { typescript: "^7.0.2", "vite-plus": "^0.2.4" },
  overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.3.1" },
};

export const plainViteManifest = {
  name: "plain-vite",
  version: "0.0.0",
  type: "module",
  scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
  devDependencies: { typescript: "~6.0.2", vite: "^7.2.0" },
};

export const monorepoRootManifest = {
  name: "gen-monorepo",
  version: "0.0.0",
  private: true,
  workspaces: ["packages/*", "apps/*", "tools/*"],
  type: "module",
  scripts: { ready: "vp check && vp run -r test", dev: "vp run website#dev" },
  devDependencies: { "vite-plus": "0.3.1" },
  overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.3.1" },
};

export const pnpmWorkspaceCatalog = `catalog:
  vite: npm:@voidzero-dev/vite-plus-core@0.3.1
  vite-plus: 0.3.1
overrides:
  vite@*: "catalog:"
`;
