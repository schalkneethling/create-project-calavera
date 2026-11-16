// #939: `yarn dlx create-project-calavera --new` failed with ENOTDIR, because Yarn 2 and later
// serve Calavera from a zip archive in Yarn's cache, and the bootstrap copied its bundled
// `src/bootstrap/calavera/` skill with `fs.promises.cp`. Yarn's Plug'n'Play (PnP) runtime patches
// `fs` so that paths inside a zip resolve, but it does not patch `cp`, so Node's own directory copy
// looked up the zip path on the real file system and failed.
//
// This test packs the CLI, stores the packed files in a zip laid out the way Yarn's cache stores a
// package, and patches `fs` with the same zip file system layer Yarn's PnP runtime installs. It then
// installs the bundled bootstrap skill from inside that zip. The test runs in its own process
// (`node --test` runs each file separately), so the patched `fs` does not reach other tests.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NodeFS, PosixFS, VirtualFS, patchFs } from "@yarnpkg/fslib";
import { ZipFS, ZipOpenFS, getLibzipSync } from "@yarnpkg/libzip";

const execFileAsync = promisify(execFile);
const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_IN_ZIP = "/node_modules/create-project-calavera";
const BOOTSTRAP_SKILL = "src/bootstrap/calavera";

/**
 * The paths of every file under `directory`, relative to it, read before `fs` is patched.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function filesUnder(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * Packs the CLI with `pnpm pack` and stores the packed files in a zip at `zipPath`, under
 * `node_modules/create-project-calavera/`, as Yarn's cache does.
 *
 * @param {string} workRoot
 * @param {string} zipPath
 * @returns {Promise<string>} The unpacked package directory, for comparison.
 */
async function packIntoYarnStyleZip(workRoot, zipPath) {
  const packDirectory = join(workRoot, "pack");
  await mkdir(packDirectory);
  await execFileAsync("pnpm", ["pack", "--pack-destination", packDirectory], { cwd: cliRoot });
  const tarball = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball for create-project-calavera.");
  await execFileAsync("tar", ["-xzf", join(packDirectory, tarball), "-C", packDirectory]);
  const unpacked = join(packDirectory, "package");

  const zip = new ZipFS(/** @type {import("@yarnpkg/fslib").PortablePath} */ (zipPath), {
    create: true,
  });
  for (const file of await filesUnder(unpacked)) {
    const target = /** @type {import("@yarnpkg/fslib").PortablePath} */ (
      `${PACKAGE_IN_ZIP}/${file}`
    );
    zip.mkdirSync(/** @type {import("@yarnpkg/fslib").PortablePath} */ (dirname(target)), {
      recursive: true,
    });
    zip.writeFileSync(target, await readFile(join(unpacked, file)));
  }
  zip.saveAndClose();
  return unpacked;
}

/**
 * Patches `fs` with the zip file system layer Yarn's PnP runtime installs (`.pnp.cjs`): a
 * VirtualFS over a read-only ZipOpenFS over the real file system.
 */
function patchFsLikeYarnPnp() {
  const zipOpenFs = new ZipOpenFS({
    baseFs: new NodeFS({ ...fs }),
    libzip: getLibzipSync(),
    maxOpenFiles: 80,
    readOnlyArchives: true,
  });
  patchFs(fs, new PosixFS(new VirtualFS({ baseFs: zipOpenFs })));
  // ES module imports of node:fs and node:fs/promises read the patched functions only after this.
  syncBuiltinESMExports();
}

test("the bundled bootstrap skill installs from a packed CLI served from a Yarn PnP zip (#939)", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "calavera-yarn-zip-"));
  const previousCwd = process.cwd();

  try {
    const zipPath = join(workRoot, "create-project-calavera-npm.zip");
    const unpacked = await packIntoYarnStyleZip(workRoot, zipPath);
    const expectedFiles = await filesUnder(join(unpacked, BOOTSTRAP_SKILL));
    assert.ok(expectedFiles.includes("SKILL.md"), "the packed CLI must bundle the bootstrap skill");

    const project = join(workRoot, "project");
    await mkdir(project);
    patchFsLikeYarnPnp();
    // Imported after patching, so the module's own fs imports are the patched ones.
    const { buildAiApplyResult } = await import("../src/ai/artifacts.js");
    const { createEmptyState } = await import("../src/state.js");

    process.chdir(project);
    const skillInZip = `${zipPath}${PACKAGE_IN_ZIP}/${BOOTSTRAP_SKILL}/`;
    const result = await buildAiApplyResult(
      { ai: [{ type: "skill", src: "skills/calavera" }] },
      { dryRun: false },
      createEmptyState(),
      new Map([["skill-calavera", skillInZip]]),
    );

    const installed = result.artifacts.find(({ type }) => type === "skill");
    assert.ok(installed, "the bootstrap recipe must install a skill");
    const installPath = join(project, installed.path);
    assert.deepEqual(await filesUnder(installPath), expectedFiles);
    for (const file of expectedFiles) {
      assert.deepEqual(
        await readFile(join(installPath, file)),
        await readFile(join(unpacked, BOOTSTRAP_SKILL, file)),
        file,
      );
    }
  } finally {
    process.chdir(previousCwd);
    await rm(workRoot, { recursive: true, force: true });
  }
});
