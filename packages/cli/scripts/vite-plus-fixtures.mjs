// Shared ADR-0001 fixtures for the Vite+ detection tests and for the tests
// that drive detection through the MCP tools and the CLI.
import {
  chmod,
  cp,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
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

/** This repository's Oxfmt command line, which the stand-in `vp fmt` runs. */
const oxfmtBin = fileURLToPath(new URL("../bin/oxfmt", import.meta.resolve("oxfmt")));

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
 * so a test can apply to the copy without mutating the committed files. Like
 * `vp create`, which installs the project's dependencies, the copy has a
 * vite-plus package whose `vp fmt` formats the files Calavera writes
 * (`writeVitePlusFormatter`). Pass `{ vitePlus: false }` for a project whose
 * dependencies are not installed.
 *
 * @param {"library" | "monorepo"} name
 * @param {{ vitePlus?: boolean }} [options]
 */
export async function copyReleaseFixture(name, { vitePlus = true } = {}) {
  const directory = await mkdtempDisposable(join(tmpdir(), `calavera-vite-plus-${name}-`));
  const root = await realpath(directory.path);
  await cp(releaseFixturePath(name), root, { recursive: true });
  if (vitePlus) {
    await writeVitePlusFormatter(root);
  }

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
 * The package.json that each package manager's `init` command writes, recorded from real runs on
 * 2026-11-23 in a directory named `fresh`: `npm init -y` from npm 11.20.0, `pnpm init` from
 * pnpm 12.21.0, `yarn init -y` from Yarn 1.22.22, and `bun init -y` from Bun 1.3.9. None orders
 * its keys the way Oxfmt sorts a package.json, so a test can show whether apply formats the file
 * it creates (#1085). Bun's writes no `scripts` key, so apply adds that key last. `bun init -y`
 * also writes index.ts, tsconfig.json, and other files, which the stand-in leaves out, and Yarn 2
 * or later writes a different manifest, which is not recorded here.
 *
 * @type {Record<string, object>}
 */
const initManifests = {
  npm: {
    name: "fresh",
    version: "1.0.0",
    description: "",
    main: "index.js",
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    keywords: [],
    author: "",
    license: "ISC",
    type: "commonjs",
  },
  pnpm: {
    name: "fresh",
    version: "1.0.0",
    description: "",
    main: "index.js",
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    keywords: [],
    author: "",
    license: "ISC",
    devEngines: {
      packageManager: { name: "pnpm", version: "12.21.0", onFail: "download" },
    },
    packageManager: "pnpm@12.21.0",
    type: "module",
  },
  yarn: { name: "fresh", version: "1.0.0", main: "index.js", license: "MIT" },
  bun: {
    name: "fresh",
    module: "index.ts",
    type: "module",
    private: true,
    devDependencies: { "@types/bun": "latest" },
    peerDependencies: { typescript: "^5" },
  },
};

/**
 * A package-manager stand-in. It records its argv and working directory, then
 * exits with STUB_EXIT, which defaults to zero. A successful `init` writes a
 * package.json, as the real command does, in the shape that command writes
 * (`initManifests`). The pnpm stand-in also refuses a root install without
 * `-w`, as pnpm does.
 *
 * @param {string} name
 */
const packageManagerStub = (name) => `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
${name === "pnpm" ? pnpmAddingToRootCheck : ""}
const exitCode = Number(process.env.STUB_EXIT ?? "0");
if (exitCode !== 0) {
  console.log("package manager stub: ERR_STUB_COMMAND the command failed");
  console.error("package manager stub: the command failed");
} else if (argv[0] === "init") {
  writeFileSync("package.json", ${JSON.stringify(json(initManifests[name]))});
}
process.exit(exitCode);
`;

/**
 * Puts a stand-in for each supported package manager in `bin`, so a test can
 * prove which one apply ran, and that a managed project ran none of them.
 *
 * @param {string} bin
 */
export async function writePackageManagerStubs(bin) {
  await mkdir(bin, { recursive: true });

  for (const name of ["npm", "pnpm", "yarn", "bun"]) {
    const path = join(bin, name);
    await writeFile(path, packageManagerStub(name));
    await chmod(path, 0o755);
  }
}

/**
 * Writes a stand-in for the vite-plus package at `node_modules/vite-plus` under
 * `directory`, shaped like vite-plus 1.0.0 where apply relies on it: the
 * manifest exports `./package.json` and declares the `vp` bin as `./bin/vp`.
 * The bin records its argv and working directory as one JSON line in
 * `logPath`, then exits with `exitCode`, so a test can assert what apply ran
 * with no network access and no real install. `vp fmt` is the exception: it
 * runs this repository's Oxfmt, as `writeVitePlusFormatter` does, and is not
 * recorded in `logPath`, because apply formats the files it writes with it (#669). A test that
 * needs to know whether apply formatted gives `fmtLogPath`, where each `vp fmt` run records its
 * argv and working directory the same way (#961). Like `vp add` in a pnpm
 * workspace, it refuses a root install without `-w` (`pnpmAddingToRootCheck`).
 * A failing bin also writes a line to standard output, which apply captures.
 * A successful `vp add -D` adds each package to the package.json in its working
 * directory the way pnpm 12.21.0 does: in an existing `devDependencies` object,
 * or in a new one appended as the last key, with the packages in alphabetical
 * order (#1085). When the environment sets
 * `VP_STUB_FMT_FAIL_FOR` to a path, `vp fmt --stdin-filepath=<that path>` exits
 * with an error, as a formatter that cannot parse one file does; with
 * `VP_STUB_ADD_MARKER` set to a path as well, only once `vp add` has run, which
 * writes that file. `VP_STUB_ADD_FAILS_AFTER_WRITE=1` makes `vp add` change
 * package.json and then fail, as an install can that stops after the package
 * manager has written the manifest.
 * `manifest` replaces the manifest's text, to give it a shape apply has to
 * refuse.
 *
 * @param {string} directory
 * @param {{ logPath: string, fmtLogPath?: string, exitCode?: number, manifest?: string }} options
 */
export async function writeVitePlusStub(
  directory,
  { logPath, fmtLogPath, exitCode = 0, manifest },
) {
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
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "fmt") {
  if (
    process.env.VP_STUB_FMT_FAIL_FOR &&
    argv.includes("--stdin-filepath=" + process.env.VP_STUB_FMT_FAIL_FOR) &&
    (!process.env.VP_STUB_ADD_MARKER || existsSync(process.env.VP_STUB_ADD_MARKER))
  ) {
    console.error("vp stub: cannot format " + process.env.VP_STUB_FMT_FAIL_FOR);
    process.exit(2);
  }
${fmtLogPath === undefined ? "" : `  appendFileSync(${JSON.stringify(fmtLogPath)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");\n`}  const result = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(oxfmtBin)}, ...argv.slice(1)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
${pnpmAddingToRootCheck}
if (${exitCode} !== 0) {
  console.log("vp stub: ERR_STUB_INSTALL the install failed");
  console.error("vp stub: the install failed");
} else if (argv[0] === "add" && argv.includes("-D") && existsSync("package.json")) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  manifest.devDependencies ??= {};
  for (const name of argv.slice(1).filter((arg) => !arg.startsWith("-"))) {
    manifest.devDependencies[name] = "^1.0.0";
  }
  // pnpm writes the dependencies in alphabetical order.
  manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\\n");
  if (process.env.VP_STUB_ADD_MARKER) writeFileSync(process.env.VP_STUB_ADD_MARKER, "");
  if (process.env.VP_STUB_ADD_FAILS_AFTER_WRITE === "1") {
    console.log("vp stub: ERR_STUB_INSTALL the install failed after writing package.json");
    process.exit(1);
  }
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
 * @param {{ bin?: Record<string, string>, banner?: string, hang?: boolean, failFor?: string }} [options] `bin`
 *   replaces the package's bin, such as to leave out vp. `banner` is printed first, as a
 *   vite.config.ts that logs does. `hang` keeps vp running forever, as a vite.config.ts that waits
 *   on something that never completes does. `failFor` makes vp exit with an error when it formats
 *   that path, as a formatter that cannot parse one file does, and formats every other path.
 */
export async function writeVitePlusFormatter(
  directory,
  { bin, banner, hang = false, failFor } = {},
) {
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
  await writeFile(
    join(packageDirectory, "bin/vp"),
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
if (command !== "fmt") {
  console.error(\`vp stub: only fmt is supported, not \${command}\`);
  process.exit(1);
}
${failFor === undefined ? "" : `if (args.includes(${JSON.stringify(`--stdin-filepath=${failFor}`)})) {\n  console.error(${JSON.stringify(`vp stub: cannot format ${failFor}`)});\n  process.exit(2);\n}\n`}${banner === undefined ? "" : `console.log(${JSON.stringify(banner)});\n`}${hang ? "await new Promise(() => setInterval(() => {}, 60_000));\n" : ""}const result = spawnSync(process.execPath, [${JSON.stringify(oxfmtBin)}, ...args], { stdio: "inherit" });
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
