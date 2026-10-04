// Tests for the supported Node.js range (#626). The range lives in
// `engines.node`; the bin entries check it before they load the CLI, so an
// unsupported Node.js gets a one-line message instead of a module-loading crash.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import semver from "semver";
import packageJson from "../package.json" with { type: "json" };
import {
  NODE_ENGINE_RANGE,
  nodeSatisfiesEngineRange,
  startOnSupportedNode,
} from "../src/node-engine.js";

const execFileAsync = promisify(execFile);
const binPaths = {
  "create-project-calavera": fileURLToPath(
    new URL("../bin/create-project-calavera.js", import.meta.url),
  ),
  "create-project-calavera-mcp": fileURLToPath(
    new URL("../bin/create-project-calavera-mcp.js", import.meta.url),
  ),
};

/**
 * A preload that makes the child report `version` as its Node.js version, so
 * the guard can be exercised on the Node.js running the tests.
 *
 * @param {string} version
 */
function fakeNodeVersionPreload(version) {
  const source = [
    `Object.defineProperty(process, "version", { value: ${JSON.stringify(version)} });`,
    `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version.slice(1))} });`,
  ].join("\n");

  return `data:text/javascript,${encodeURIComponent(source)}`;
}

test("the CLI declares the Vite+ 1.0.0 floor as its supported Node.js range", () => {
  assert.equal(packageJson.engines.node, "^22.18.0 || ^24.11.0 || >=26.0.0");
});

test("the code reads the supported range from engines.node", () => {
  assert.equal(NODE_ENGINE_RANGE, packageJson.engines.node);
});

test("the range check accepts each range and rejects the versions around them", () => {
  for (const version of [
    "v22.18.0",
    "v22.30.1",
    "v24.11.0",
    "v24.21.0",
    "v26.0.0",
    "v27.1.0",
    "22.18.0",
  ]) {
    assert.equal(nodeSatisfiesEngineRange(version), true, version);
  }
  for (const version of [
    "v20.19.6",
    "v22.0.0",
    "v22.17.9",
    "v23.0.0",
    "v23.11.0",
    "v24.0.0",
    "v24.10.9",
    "v25.0.0",
    "v25.9.0",
  ]) {
    assert.equal(nodeSatisfiesEngineRange(version), false, version);
  }
});

test("the range check accepts prereleases of supported lines and rejects those of unsupported lines", () => {
  for (const version of [
    "v22.18.0-pre",
    "v22.18.1-pre",
    "v24.12.0-nightly20260101abcdef",
    "v26.0.0-rc.1",
  ]) {
    assert.equal(nodeSatisfiesEngineRange(version), true, version);
    assert.equal(semver.satisfies(version, packageJson.engines.node), false, version);
  }
  for (const version of ["v25.0.0-rc.1", "v24.10.0-nightly20260101abcdef", "v22.17.0-rc.2"]) {
    assert.equal(nodeSatisfiesEngineRange(version), false, version);
  }
});

test("the range check agrees with semver on engines.node for release versions", () => {
  for (let major = 18; major <= 30; major += 1) {
    for (let minor = 0; minor <= 30; minor += 1) {
      for (const patch of [0, 9]) {
        const version = `v${major}.${minor}.${patch}`;

        assert.equal(
          nodeSatisfiesEngineRange(version),
          semver.satisfies(version, packageJson.engines.node),
          version,
        );
      }
    }
  }
});

test("the bin entries point at the guarded entry modules", () => {
  assert.deepEqual(packageJson.bin, {
    "create-project-calavera": "bin/create-project-calavera.js",
    "create-project-calavera-mcp": "bin/create-project-calavera-mcp.js",
  });
  assert.ok(packageJson.files.includes("bin"));
});

/**
 * The module specifiers a source file loads statically: `import … from`,
 * side-effect `import "…"`, and `export … from`.
 *
 * @param {string} source
 */
function staticSpecifiers(source) {
  const pattern =
    /^\s*(?:import\s*(?:[^;"'`]*?\sfrom\s*)?|export\s[^;"'`]*?\sfrom\s*)["']([^"']+)["']/gmu;

  return [...source.matchAll(pattern)].map(([, specifier]) => specifier);
}

test("the static import scan finds every form of static import", () => {
  assert.deepEqual(
    staticSpecifiers(
      [
        'import "side-effect";',
        'import { a,\n  b } from "named";',
        "import * as all from 'namespace';",
        'export * from "re-export-all";',
        'export { c } from "re-export-named";',
        'export const d = require("not-static");',
        'const e = await import("dynamic");',
      ].join("\n"),
    ),
    ["side-effect", "named", "namespace", "re-export-all", "re-export-named"],
  );
});

test("the guard modules load nothing that could fail on an unsupported Node.js", async () => {
  const guardModules = {
    "src/node-engine.js": ["node:module", "node:util"],
    "bin/create-project-calavera.js": ["../src/node-engine.js"],
    "bin/create-project-calavera-mcp.js": ["../src/node-engine.js"],
  };

  for (const [path, allowed] of Object.entries(guardModules)) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");

    assert.deepEqual(staticSpecifiers(source), allowed, path);
    assert.doesNotMatch(source, /\bwith\s*\{\s*type:/u, `${path} must not use import attributes`);
    assert.doesNotMatch(source, /^await\b/mu, `${path} must not use top-level await`);
    assert.doesNotMatch(source, /\?\?|\?\./u, `${path} must not use ?? or ?.`);
  }
});

test("a failing entry prints its error and sets a non-zero exit code", async () => {
  const stderrWrites = [];
  const originalWrite = process.stderr.write;
  const originalExitCode = process.exitCode;

  try {
    process.stderr.write = (chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    };
    const error = Object.assign(
      new Error("module failed to load", { cause: new Error("underlying cause") }),
      { code: "ERR_EXAMPLE" },
    );
    await startOnSupportedNode("create-project-calavera", () => Promise.reject(error));

    assert.equal(process.exitCode, 1);
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = originalExitCode;
  }

  assert.equal(stderrWrites.length, 1);
  assert.match(stderrWrites[0], /^Error: module failed to load\n {4}at /u);
  assert.match(stderrWrites[0], /\[cause\]: Error: underlying cause/u);
  assert.match(stderrWrites[0], /code: 'ERR_EXAMPLE'/u);
});

for (const [command, binPath] of Object.entries(binPaths)) {
  test(`${command} prints one line naming the range and exits non-zero on an unsupported Node.js`, async () => {
    const result = await execFileAsync(
      process.execPath,
      ["--import", fakeNodeVersionPreload("v20.19.6"), binPath, "--help"],
      { encoding: "utf8" },
    ).then(
      () => assert.fail(`${command} exited with code 0 on Node.js v20.19.6`),
      (error) => error,
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `${command} requires Node.js ${packageJson.engines.node}. This is Node.js v20.19.6.\n`,
    );
  });
}

test("create-project-calavera runs on a supported Node.js through a package-manager-style symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-node-engine-"));
  const symlinkPath = join(directory, "create-project-calavera");

  try {
    await symlink(binPaths["create-project-calavera"], symlinkPath);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", fakeNodeVersionPreload("v22.18.0"), symlinkPath, "--help"],
      { encoding: "utf8" },
    );

    assert.match(stdout, /^create-project-calavera /u);
    assert.equal(stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
