// Shared ADR-0001 fixtures for the Vite+ detection tests and for the tests
// that drive detection through the MCP tools and the CLI.
import { cp, mkdir, mkdtempDisposable, readFile, realpath, writeFile } from "node:fs/promises";
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

/**
 * Stand-in source, for a CommonJS script whose arguments are in `argv`, that
 * refuses `add` at the root of a pnpm workspace without `-w` the way pnpm
 * does (#731). pnpm 10 and 11 raise `ERR_PNPM_ADDING_TO_ROOT` when the working
 * directory is the workspace directory, neither `-w` nor `--workspace-root`
 * is given, and `pnpm-workspace.yaml` lists more than one package pattern.
 * The YAML is read with the `yaml` package Calavera itself depends on.
 */
export const pnpmAddingToRootCheck = `
if (argv[0] === "add" && !argv.includes("-w") && !argv.includes("--workspace-root")) {
  const { existsSync, readFileSync } = require("node:fs");
  const packages = existsSync("pnpm-workspace.yaml")
    ? require(${JSON.stringify(fileURLToPath(import.meta.resolve("yaml")))}).parse(readFileSync("pnpm-workspace.yaml", "utf8"))?.packages
    : undefined;
  if (Array.isArray(packages) && packages.length > 1) {
    console.log("ERR_PNPM_ADDING_TO_ROOT Running this command will add the dependency to the workspace root, which might not be what you want - if you really meant it, make it explicit by running this command again with the -w flag (or --workspace-root).");
    process.exit(1);
  }
}
`;

/**
 * Writes a stand-in for the vite-plus package at `node_modules/vite-plus` under
 * `directory`, shaped like vite-plus 1.0.0 where apply relies on it: the
 * manifest exports `./package.json` and declares the `vp` bin as `./bin/vp`.
 * The bin records its argv and working directory as one JSON line in
 * `logPath`, then exits with `exitCode`, so a test can assert what apply ran
 * with no network access and no real install. Like `vp add` in a pnpm
 * workspace, it refuses a root install without `-w` (`pnpmAddingToRootCheck`).
 * A failing bin also writes a line to standard output, which apply captures.
 * `manifest` replaces the manifest's text, to give it a shape apply has to
 * refuse.
 *
 * @param {string} directory
 * @param {{ logPath: string, exitCode?: number, manifest?: string }} options
 */
export async function writeVitePlusStub(directory, { logPath, exitCode = 0, manifest }) {
  const packageDirectory = join(directory, "node_modules/vite-plus");
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    manifest ??
      json({
        name: "vite-plus",
        version: vitePlusFixtureRelease,
        bin: { vp: "./bin/vp", vpr: "./bin/vpr" },
        exports: { "./package.json": "./package.json" },
      }),
  );
  await writeFile(
    join(packageDirectory, "bin/vp"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
${pnpmAddingToRootCheck}
if (${exitCode} !== 0) {
  console.log("vp stub: ERR_STUB_INSTALL the install failed");
  console.error("vp stub: the install failed");
}
process.exit(${exitCode});
`,
  );
}

/**
 * Installs a `vite-plus` package in `directory` whose `vp fmt` hands its arguments to this
 * repository's Oxfmt command line. Like Vite+, Oxfmt then reads the formatter settings from the
 * project directory, here `.oxfmtrc.json` and `.editorconfig`, so a test can configure them.
 *
 * @param {string} directory
 * @param {{ bin?: Record<string, string>, banner?: string }} [options] `bin` replaces the package's
 *   bin, such as to leave out vp. `banner` is printed first, as a vite.config.ts that logs does.
 */
export async function writeVitePlusFormatter(directory, { bin, banner } = {}) {
  const packageDirectory = join(directory, "node_modules/vite-plus");
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    json({
      name: "vite-plus",
      version: vitePlusFixtureRelease,
      type: "module",
      bin: bin ?? { vp: "./bin/vp" },
      exports: { "./package.json": "./package.json" },
    }),
  );
  const oxfmt = fileURLToPath(new URL("../bin/oxfmt", import.meta.resolve("oxfmt")));
  await writeFile(
    join(packageDirectory, "bin/vp"),
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
if (command !== "fmt") {
  console.error(\`vp stub: only fmt is supported, not \${command}\`);
  process.exit(1);
}
${banner === undefined ? "" : `console.log(${JSON.stringify(banner)});\n`}const result = spawnSync(process.execPath, [${JSON.stringify(oxfmt)}, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
  );
}

/**
 * The invocations a stub recorded, one per line of `logPath`; none when the
 * stub never ran.
 *
 * @param {string} logPath
 * @returns {Promise<Array<{ argv: string[], cwd: string }>>}
 */
export async function readStubInvocations(logPath) {
  let contents;

  try {
    contents = await readFile(logPath, "utf8");
  } catch {
    return [];
  }

  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
