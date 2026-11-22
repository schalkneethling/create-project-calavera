// Issue #1136: `artifacts install` and `artifacts update` remove their staging folder after the
// install commits. When that removal fails, both commands finish, keep what they installed, and
// name the folder with its remedy in `temporaryFolderLeftovers`, as apply does since #1033. A
// failure that stops the command still exits non-zero with its own cause first.
//
// The removal fails for real: the registry stand-in leaves a folder in the staging folder that the
// process may not write to, so removing the file inside it fails with EACCES.
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { formatTemporaryFolderLeftovers } from "../src/artifact-status-report.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const ID = "skill-project-goal";
const SECOND = "skill-code-review";
const CONFIG = "calavera.config.json";
const LOCK = ".calavera/artifacts.lock.json";

// A superuser may write to a read-only folder, so the removal would not fail.
const skip = process.getuid?.() === 0 ? "removal cannot fail for the superuser" : false;

/**
 * Each staging folder a test made unremovable. `inProject` makes each writable again and removes
 * it by its exact path once the test ends.
 *
 * @type {string[]}
 */
const stuckStagingFolders = [];

/**
 * Runs `callback` in a new project whose recipe selects `skill-project-goal`.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  const originalDirectory = process.cwd();
  const project = await realpath(await mkdtemp(join(tmpdir(), "calavera-install-cleanup-")));
  try {
    process.chdir(project);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    await writeFile(
      CONFIG,
      `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: ID }] }, null, 2)}\n`,
    );
    await callback();
  } finally {
    process.chdir(originalDirectory);
    for (const folder of stuckStagingFolders.splice(0)) {
      await chmod(join(folder, "stuck"), 0o700);
      await rm(folder, { recursive: true, force: true });
    }
    await rm(project, { recursive: true, force: true });
  }
}

/**
 * A registry stand-in that serves `version` and, as it extracts a package into the staging
 * folder, leaves a folder there that the process may not write to, so removing the staging folder
 * fails. Records each staging folder in `stagingFolders` and in `stuckStagingFolders`.
 *
 * @param {string} version
 * @param {Parameters<typeof stubRegistry>[1]} [options]
 */
function registryWithStuckStaging(version, options = {}) {
  const registry = stubRegistry(
    new Map([
      [ID, version],
      [SECOND, version],
    ]),
    options,
  );
  /** @type {string[]} */
  const stagingFolders = [];
  return {
    stagingFolders,
    registry: {
      ...registry,
      extract: async (
        /** @type {Parameters<typeof registry.extract>[0]} */ resolution,
        /** @type {string} */ destination,
      ) => {
        const extracted = await registry.extract(resolution, destination);
        // The destination is <staging folder>/packages/<id>.
        const stagingFolder = dirname(dirname(destination));
        if (stagingFolders.includes(stagingFolder)) return extracted;
        stagingFolders.push(stagingFolder);
        stuckStagingFolders.push(stagingFolder);
        await mkdir(join(stagingFolder, "stuck"));
        await writeFile(join(stagingFolder, "stuck", "file"), "");
        await chmod(join(stagingFolder, "stuck"), 0o500);
        return extracted;
      },
    },
  };
}

/** @param {string} folder @param {boolean} inProject */
const leftover = (folder, inProject) => ({
  path: folder,
  reason: `Calavera could not remove this temporary folder (EACCES). Nothing in the project uses it, so remove it yourself.${inProject ? " It is inside the project and Git does not ignore it, so remove it before you commit." : ""}`,
});

test(
  "artifacts install finishes, keeps what it installed, and names the staging folder it could not remove",
  { skip },
  async () => {
    await inProject(async () => {
      const { registry, stagingFolders } = registryWithStuckStaging("0.1.0");

      const result = await runArtifactCommand(
        { config: CONFIG, dryRun: false, artifactAction: "install" },
        registry,
      );

      assert.equal(stagingFolders.length, 1);
      assert.deepEqual(result.temporaryFolderLeftovers, [leftover(stagingFolders[0], true)]);
      assert.ok(
        (await stat(stagingFolders[0])).isDirectory(),
        "the folder was not left as reported",
      );
      const lock = JSON.parse(await readFile(LOCK, "utf8"));
      assert.deepEqual(
        lock.artifacts.map((/** @type {{ id: string, version: string }} */ { id, version }) => ({
          id,
          version,
        })),
        [{ id: ID, version: "0.1.0" }],
      );
    });
  },
);

test(
  "artifacts update finishes, keeps the update, and names the staging folder it could not remove",
  { skip },
  async () => {
    await inProject(async () => {
      await runArtifactCommand(
        { config: CONFIG, dryRun: false, artifactAction: "install" },
        stubRegistry(new Map([[ID, "0.1.0"]])),
      );
      const { registry, stagingFolders } = registryWithStuckStaging("0.2.0");

      const result = await runArtifactCommand(
        { config: CONFIG, dryRun: false, artifactAction: "update", artifactId: ID },
        registry,
      );

      assert.equal(stagingFolders.length, 1);
      assert.deepEqual(result.temporaryFolderLeftovers, [leftover(stagingFolders[0], true)]);
      const lock = JSON.parse(await readFile(LOCK, "utf8"));
      assert.equal(lock.artifacts[0].version, "0.2.0");
    });
  },
);

test(
  "the artifacts install dry run finishes and names the temporary folder it could not remove",
  { skip },
  async () => {
    await inProject(async () => {
      const { registry, stagingFolders } = registryWithStuckStaging("0.1.0");

      const result = await runArtifactCommand(
        { config: CONFIG, dryRun: true, artifactAction: "install" },
        registry,
      );

      assert.equal(stagingFolders.length, 1);
      assert.deepEqual(result.temporaryFolderLeftovers, [leftover(stagingFolders[0], false)]);
      await assert.rejects(stat(LOCK), { code: "ENOENT" });
    });
  },
);

test("artifacts install reports no leftover when the staging folder is removed", async () => {
  await inProject(async () => {
    const result = await runArtifactCommand(
      { config: CONFIG, dryRun: false, artifactAction: "install" },
      stubRegistry(new Map([[ID, "0.1.0"]])),
    );

    assert.deepEqual(result.temporaryFolderLeftovers, []);
    // The transaction folder stays, and the staging folder inside it is gone.
    assert.deepEqual(await readdir(".calavera/.transactions"), []);
  });
});

test(
  "a failure after staging still stops artifacts install with its own cause first",
  { skip },
  async () => {
    await inProject(async () => {
      await writeFile(
        CONFIG,
        `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: ID }, { id: SECOND }] }, null, 2)}\n`,
      );
      // The first artifact stages, which leaves the unremovable folder, and then the second
      // artifact's lookup fails.
      const { registry, stagingFolders } = registryWithStuckStaging("0.1.0", {
        failFor: SECOND,
        error: new Error("The lookup stopped."),
      });

      await assert.rejects(
        runArtifactCommand({ config: CONFIG, dryRun: false, artifactAction: "install" }, registry),
        (/** @type {AggregateError} */ error) => {
          assert.equal(error.errors[0].message, "The lookup stopped.");
          assert.equal(error.cause, error.errors[0]);
          assert.match(error.message, /^The lookup stopped\. /);
          assert.ok(
            error.message.includes(`Could not remove ${stagingFolders[0]} (EACCES).`),
            error.message,
          );
          return true;
        },
      );
      await assert.rejects(stat(LOCK), { code: "ENOENT" });
    });
  },
);

test("the install and update text output warns about each folder with its remedy", () => {
  const folder = "/tmp-like/calavera-artifact-stage-abc";
  const reason = leftover(folder, false).reason;
  assert.deepEqual(
    formatTemporaryFolderLeftovers({ temporaryFolderLeftovers: [{ path: folder, reason }] }),
    [`Not removed ${folder}: ${reason}`],
  );
  assert.deepEqual(formatTemporaryFolderLeftovers({ temporaryFolderLeftovers: [] }), []);
});
