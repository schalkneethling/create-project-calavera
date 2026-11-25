// Issue #841: apply resolves artifact packages through an npm cache in `.calavera/cache/`. The
// owner decided on 2026-11-14 that the cache is not committed. Apply keeps it out of Git with a
// marked `.gitignore` block, the ADR-0016 approach, and the apply summary says so. Issue #960: the
// owner decided on 2026-11-17 that `artifacts install`, `artifacts update`, and
// `artifacts status --check-updates`, which create the cache too, write and record the same block.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { fixture } from "./ignore-fixture-integration.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const applyOptions = { json: true, noInstall: true, assumeYes: true };
const cacheBlock =
  "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n";
const cacheChange = (/** @type {string} */ type) => ({
  path: ".gitignore",
  integration: "artifact-cache",
  type,
  lines: [".calavera/cache/"],
});

/** @param {string[]} ids */
function recipeWith(ids) {
  return { ...buildRecipe("minimal", [], "npm"), ai: ids.map((id) => ({ id })) };
}

const registry = () => stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));

/** @param {{ pointers?: string[] }} result */
const cachePointers = (result) =>
  (result.pointers ?? []).filter((pointer) => pointer.includes(".calavera/cache/"));

/**
 * Runs `callback` in a new temporary project that holds a package.json and, when given, the
 * person's own .gitignore.
 *
 * @param {string | undefined} gitignore
 * @param {(directory: string) => Promise<void>} callback
 */
async function inProject(gitignore, callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-cache-gitignore-"));
  const directory = await realpath(project.path);
  const originalDirectory = process.cwd();
  process.chdir(directory);

  try {
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    if (gitignore !== undefined) await writeFile(".gitignore", gitignore);
    await callback(directory);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string[]} args */
function git(args) {
  const run = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  return run.stdout;
}

test("the dry run plans the cache block and says why, and writes nothing", async () => {
  await inProject("node_modules/\n", async () => {
    const recipe = recipeWith(["skill-project-goal"]);
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());

    assert.deepEqual(dryRun.ignoreChanges, [cacheChange("update")]);
    const [pointer, ...others] = cachePointers(dryRun);
    assert.deepEqual(others, []);
    assert.match(pointer ?? "", /does not belong in Git/);
    assert.match(
      pointer ?? "",
      /Commit \.calavera\/artifacts\.lock\.json and \.calavera\/packages\//,
    );
    assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");

    const mcpDryRun = await callMcpTool("dry_run_apply", { recipe }, registry());
    assert.deepEqual(mcpDryRun.result.ignoreChanges, dryRun.ignoreChanges);
  });
});

test("after apply, git status does not list the cache but lists the files to commit", async () => {
  await inProject(undefined, async () => {
    git(["init", "--quiet"]);
    const recipe = recipeWith(["skill-project-goal"]);
    const applied = await applyRecipeObject(recipe, applyOptions, registry());

    assert.equal(await readFile(".gitignore", "utf8"), cacheBlock);
    assert.equal(cachePointers(applied).length, 1);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.gitignoreBlocks, [
      { integration: "artifact-cache", lines: [".calavera/cache/"] },
    ]);

    // The folders npm writes into its cache, as the #749 run found them.
    for (const folder of ["content-v2", "index-v5", "tmp"]) {
      await mkdir(`.calavera/cache/npm/${folder}`, { recursive: true });
      await writeFile(`.calavera/cache/npm/${folder}/entry`, "cached\n");
    }
    await writeFile(
      ".calavera/cache/npm/CACHEDIR.TAG",
      "Signature: 8a477f597d28d172789f06886806bc55\n",
    );

    const untracked = git(["status", "--porcelain", "--untracked-files=all"]).split("\n");
    assert.deepEqual(
      untracked.filter((line) => line.includes(".calavera/cache")),
      [],
    );
    assert.ok(untracked.includes("?? .calavera/artifacts.lock.json"), untracked.join("\n"));
    assert.ok(
      untracked.some((line) => line.startsWith("?? .calavera/packages/")),
      untracked.join("\n"),
    );

    // A second dry run reports the block as unchanged and does not repeat the explanation.
    const again = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());
    assert.deepEqual(again.ignoreChanges, [cacheChange("unchanged")]);
    assert.deepEqual(cachePointers(again), []);
  });
});

test("a recipe without artifacts plans no cache block while no cache folder exists", async () => {
  await inProject(undefined, async () => {
    const dryRun = await applyRecipeObject(recipeWith([]), { ...applyOptions, dryRun: true });

    assert.deepEqual(dryRun.ignoreChanges, []);
    assert.deepEqual(cachePointers(dryRun), []);
  });
});

test("a cache folder an earlier apply left behind keeps its block when the recipe drops artifacts", async () => {
  await inProject(undefined, async () => {
    await mkdir(".calavera/cache/npm", { recursive: true });

    const dryRun = await applyRecipeObject(recipeWith([]), { ...applyOptions, dryRun: true });

    assert.deepEqual(dryRun.ignoreChanges, [cacheChange("write")]);
  });
});

test("the block leaves with the cache, and the dry run says why", async () => {
  await inProject(`node_modules/\n${cacheBlock}`, async (directory) => {
    await mkdir(".calavera");
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify({
        version: 1,
        integrations: [],
        managedFiles: [],
        gitignoreBlocks: [{ integration: "artifact-cache", lines: [".calavera/cache/"] }],
      })}\n`,
    );
    await writeFile("calavera.config.json", `${JSON.stringify(recipeWith([]), null, 2)}\n`);

    const run = spawnSync(process.execPath, [cli, "apply", "--dry-run", "--yes", "--no-install"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(
      `${run.stdout}${run.stderr}`,
      // #617: the block's line sits under the line for the file, so the path is named once.
      /^ {2}Would update \.gitignore\n {4}Would remove the artifact-cache block, because the recipe selects no artifacts and \.calavera\/cache\/ does not exist: "\.calavera\/cache\/"$/m,
    );

    const removing = await applyRecipeObject(recipeWith([]), { ...applyOptions, dryRun: true });
    assert.deepEqual(cachePointers(removing), []);

    await applyRecipeObject(recipeWith([]), applyOptions);
    assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");
  });
});

test("with Varlock, apply keeps the cache block and appends the Varlock lines after it", async () => {
  await inProject(undefined, async () => {
    const recipe = {
      ...buildRecipe("minimal", ["varlock"], "npm"),
      ai: [{ id: "skill-project-goal" }],
    };
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());
    assert.deepEqual(dryRun.ignoreChanges, [cacheChange("write")]);
    assert.equal(dryRun.changes.filter(({ path }) => path === ".gitignore").length, 1);

    await applyRecipeObject(recipe, applyOptions, registry());
    const gitignore = await readFile(".gitignore", "utf8");
    assert.ok(gitignore.startsWith(cacheBlock), gitignore);
    assert.match(gitignore.slice(cacheBlock.length), /\.env\.local/);

    const again = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());
    assert.deepEqual(again.ignoreChanges, [cacheChange("unchanged")]);
  });
});

test("an integration's own block, without an artifact, adds no pointer", async () => {
  await inProject(undefined, async () => {
    const recipe = buildRecipe("minimal", [fixture.id], "npm");
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.deepEqual(
      dryRun.ignoreChanges.map(({ integration, type }) => ({ integration, type })),
      [{ integration: fixture.id, type: "write" }],
    );
    assert.deepEqual(dryRun.pointers, []);
  });
});

test("no catalog integration takes the id of Calavera's own cache block", () => {
  assert.equal(
    integrationCatalog.some(({ id }) => id === "artifact-cache"),
    false,
  );
});

// #960: the artifacts commands. The stand-in registry fills the cache it is given, as npm does, so
// git status sees what a real run leaves behind.
const cachingRegistry = () => {
  const stub = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
  return {
    ...stub,
    resolve: async (
      /** @type {{ id: string, tag?: string, version?: string, cache: string }} */ request,
    ) => {
      await mkdir(join(request.cache, "content-v2"), { recursive: true });
      await writeFile(join(request.cache, "content-v2", "entry"), "cached\n");
      return stub.resolve(request);
    },
  };
};

const cacheRecord = { integration: "artifact-cache", lines: [".calavera/cache/"] };
const fixtureBlock = `# calavera:${fixture.id}:start\n${fixture.ignore.gitignore.join("\n")}\n# calavera:${fixture.id}:end\n`;
const fixtureRecord = { integration: fixture.id, lines: fixture.ignore.gitignore };

/**
 * The project an earlier apply left: the recipe selects skill-project-goal, nothing is locked yet,
 * and `.gitignore` holds the person's line and an integration's block that apply recorded, which
 * the artifacts commands must keep.
 */
async function artifactProject() {
  await writeFile(
    "calavera.config.json",
    `${JSON.stringify(recipeWith(["skill-project-goal"]), null, 2)}\n`,
  );
  await mkdir(".calavera");
  await writeFile(
    ".calavera/state.json",
    `${JSON.stringify({
      version: 1,
      integrations: [],
      managedFiles: [],
      gitignoreBlocks: [fixtureRecord],
    })}\n`,
  );
}

/** @param {string} artifactAction @param {Record<string, unknown>} [extra] */
const artifactOptions = (artifactAction, extra = {}) => ({
  config: "calavera.config.json",
  dryRun: false,
  artifactAction,
  ...extra,
});

/** The status the commands run after an install, which locks skill-project-goal. */
async function lockedProject() {
  await artifactProject();
  await runArtifactCommand(
    artifactOptions("install"),
    stubRegistry(new Map([["skill-project-goal", "0.1.0"]])),
  );
  // The project an install before #960 left: the lock and the payload, but no cache block.
  await writeFile(".gitignore", `node_modules/\n${fixtureBlock}`);
}

const commands = [
  {
    name: "artifacts install",
    rerun: "artifacts install",
    options: artifactOptions("install"),
    setup: artifactProject,
  },
  {
    name: "artifacts update --all",
    rerun: "artifacts update",
    options: artifactOptions("update", { artifactAll: true }),
    setup: artifactProject,
  },
  {
    name: "artifacts update <id>",
    rerun: "artifacts update",
    options: artifactOptions("update", { artifactId: "skill-project-goal" }),
    setup: artifactProject,
  },
  {
    name: "artifacts status --check-updates",
    rerun: "artifacts status --check-updates",
    options: artifactOptions("status", { checkUpdates: true }),
    setup: lockedProject,
  },
  {
    name: "artifacts doctor --check-updates",
    rerun: "artifacts doctor --check-updates",
    options: artifactOptions("doctor", { checkUpdates: true }),
    setup: lockedProject,
  },
];

for (const { name, rerun, options, setup } of commands) {
  test(`${name} writes and records the cache block, so git status does not list the cache`, async () => {
    await inProject(`node_modules/\n${fixtureBlock}`, async () => {
      git(["init", "--quiet"]);
      await setup();
      const before = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      // The install that sets up a locked project may itself have written the block. Take the
      // project back to before #960, so the command under test is the one that adds it.
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...before, gitignoreBlocks: [fixtureRecord] })}\n`,
      );
      await writeFile(".gitignore", `node_modules/\n${fixtureBlock}`);

      const result = await runArtifactCommand(options, cachingRegistry());

      assert.ok(
        git(["status", "--porcelain", "--untracked-files=all", "--ignored"]).includes(
          "!! .calavera/cache/",
        ),
      );
      assert.equal(
        await readFile(".gitignore", "utf8"),
        `node_modules/\n${fixtureBlock}${cacheBlock}`,
      );
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      assert.deepEqual(state.gitignoreBlocks, [fixtureRecord, cacheRecord]);
      assert.deepEqual(result.ignoreChanges, [cacheChange("update")]);
      assert.equal(cachePointers(result).length, 1);

      const untracked = git(["status", "--porcelain", "--untracked-files=all"]).split("\n");
      assert.deepEqual(
        untracked.filter((line) => line.includes(".calavera/cache")),
        [],
      );

      // Running it again finds the block it wrote, does not explain it again, and does not
      // replace the file: the transaction writes by renaming, which would change its inode.
      const { ino } = await stat(".gitignore");
      const again = await runArtifactCommand(options, cachingRegistry());
      assert.deepEqual(again.ignoreChanges, [cacheChange("unchanged")]);
      assert.deepEqual(cachePointers(again), []);
      assert.equal(
        await readFile(".gitignore", "utf8"),
        `node_modules/\n${fixtureBlock}${cacheBlock}`,
      );
      assert.equal((await stat(".gitignore")).ino, ino);
      // The transactions leave no staging behind.
      assert.deepEqual(await readdir(".calavera/.transactions"), []);
    });
  });

  test(`${name} --dry-run reports the cache block and writes nothing`, async () => {
    await inProject(`node_modules/\n${fixtureBlock}`, async () => {
      await setup();
      await writeFile(".gitignore", `node_modules/\n${fixtureBlock}`);
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...state, gitignoreBlocks: [fixtureRecord] })}\n`,
      );
      const before = await snapshotDirectory();

      const planned = await runArtifactCommand({ ...options, dryRun: true }, cachingRegistry());

      assert.equal(planned.dryRun, true);
      assert.deepEqual(planned.ignoreChanges, [cacheChange("update")]);
      assert.equal(cachePointers(planned).length, 1);
      assert.deepEqual(await snapshotDirectory(), before);
    });
  });

  test(`${name} stops before writing anything when the person edited the cache block`, async () => {
    await inProject(undefined, async () => {
      await setup();
      const edited =
        "node_modules/\n# calavera:artifact-cache:start\n.calavera/cache/npm/\n# calavera:artifact-cache:end\n";
      await writeFile(".gitignore", edited);
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...state, gitignoreBlocks: [cacheRecord] })}\n`,
      );
      const before = await snapshotDirectory();
      const registry = cachingRegistry();

      for (const dryRun of [true, false]) {
        await assert.rejects(
          runArtifactCommand({ ...options, dryRun }, registry),
          (/** @type {Error} */ error) => {
            assert.match(error.message, /Calavera stopped before writing anything/);
            assert.match(error.message, /artifact-cache was edited since Calavera wrote it/);
            assert.ok(error.message.includes(`and run ${rerun} again.`), error.message);
            return true;
          },
        );
      }
      assert.deepEqual(registry.requests, []);
      assert.equal(await readFile(".gitignore", "utf8"), edited);
      assert.deepEqual(await snapshotDirectory(), before);
    });
  });
}

test("artifacts status without --check-updates contacts no registry and writes no block", async () => {
  await inProject(undefined, async () => {
    await lockedProject();
    await writeFile(".gitignore", "node_modules/\n");
    const before = await snapshotDirectory();

    const result = await runArtifactCommand(artifactOptions("status"), cachingRegistry());

    assert.deepEqual(result.ignoreChanges, []);
    assert.deepEqual(cachePointers(result), []);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

// An install that selects nothing resolves nothing, so this runs the real CLI without a registry.
// The cache folder an earlier run left still gets its block.
test("the text output of an artifacts command shows the cache block it adds and why", async () => {
  await inProject("node_modules/\n", async (directory) => {
    await writeFile("calavera.config.json", `${JSON.stringify(recipeWith([]), null, 2)}\n`);
    await mkdir(".calavera/cache/npm", { recursive: true });
    /** @param {string[]} args */
    const run = (args) => {
      const ran = spawnSync(process.execPath, [cli, "artifacts", "install", ...args], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
      return `${ran.stdout}${ran.stderr}`;
    };

    const planned = run(["--dry-run"]);
    assert.match(
      planned,
      /Would add the artifact-cache block to \.gitignore: "\.calavera\/cache\/"/,
    );
    assert.match(planned, /does not belong in Git/);
    assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");

    const installed = run([]);
    assert.doesNotMatch(installed, /Would add/);
    assert.match(installed, /does not belong in Git/);
    assert.equal(await readFile(".gitignore", "utf8"), `node_modules/\n${cacheBlock}`);
  });
});

// #1135: the dry run prints the replaced cache block through apply's formatter, with the file
// named in the line, because no file line stands above it.
test("the text output of artifacts install --dry-run shows a replaced cache block with the lines it had and gets", async () => {
  const oldBlock =
    "# calavera:artifact-cache:start\n.calavera/cache/npm/\n# calavera:artifact-cache:end\n";
  await inProject(`node_modules/\n${oldBlock}`, async (directory) => {
    await writeFile("calavera.config.json", `${JSON.stringify(recipeWith([]), null, 2)}\n`);
    await mkdir(".calavera/cache/npm", { recursive: true });
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify({
        version: 1,
        integrations: [],
        managedFiles: [],
        gitignoreBlocks: [{ integration: "artifact-cache", lines: [".calavera/cache/npm/"] }],
      })}\n`,
    );

    const ran = spawnSync(process.execPath, [cli, "artifacts", "install", "--dry-run"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.match(
      ran.stdout,
      /^Would replace the artifact-cache block in \.gitignore: "\.calavera\/cache\/npm\/" with "\.calavera\/cache\/"$/m,
    );
    assert.equal(await readFile(".gitignore", "utf8"), `node_modules/\n${oldBlock}`);
  });
});

for (const { name, options, setup } of commands) {
  test(`${name} creates .gitignore with the cache block alone when the project has none`, async () => {
    await inProject(undefined, async () => {
      await setup();
      await rm(".gitignore", { force: true });
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...state, gitignoreBlocks: [] })}\n`,
      );

      const result = await runArtifactCommand(options, cachingRegistry());

      assert.deepEqual(result.ignoreChanges, [cacheChange("write")]);
      assert.equal(await readFile(".gitignore", "utf8"), cacheBlock);
      const written = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      assert.deepEqual(written.gitignoreBlocks, [cacheRecord]);
    });
  });

  test(`${name} replaces a cache block that still holds the lines Calavera recorded, keeping the other records in place`, async () => {
    const oldBlock =
      "# calavera:artifact-cache:start\n.calavera/cache/npm/\n# calavera:artifact-cache:end\n";
    const oldRecord = { integration: "artifact-cache", lines: [".calavera/cache/npm/"] };
    await inProject(undefined, async () => {
      await setup();
      await writeFile(".gitignore", `node_modules/\n${oldBlock}${fixtureBlock}`);
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...state, gitignoreBlocks: [oldRecord, fixtureRecord] })}\n`,
      );

      const result = await runArtifactCommand(options, cachingRegistry());

      assert.deepEqual(result.ignoreChanges, [
        { ...cacheChange("update"), previousLines: oldRecord.lines },
      ]);
      assert.equal(
        await readFile(".gitignore", "utf8"),
        `node_modules/\n${cacheBlock}${fixtureBlock}`,
      );
      const written = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      assert.deepEqual(written.gitignoreBlocks, [cacheRecord, fixtureRecord]);
    });
  });
}

test("artifacts install never removes a recorded cache block, even when nothing needs it", async () => {
  await inProject(`node_modules/\n${cacheBlock}`, async () => {
    await writeFile("calavera.config.json", `${JSON.stringify(recipeWith([]), null, 2)}\n`);
    await mkdir(".calavera");
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify({ version: 1, integrations: [], managedFiles: [], gitignoreBlocks: [cacheRecord] })}\n`,
    );

    const result = await runArtifactCommand(artifactOptions("install"), cachingRegistry());

    assert.deepEqual(result.ignoreChanges, []);
    assert.equal(await readFile(".gitignore", "utf8"), `node_modules/\n${cacheBlock}`);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.gitignoreBlocks, [cacheRecord]);
  });
});

test("artifacts status --check-updates with nothing to check contacts no registry and writes no block", async () => {
  await inProject("node_modules/\n", async () => {
    await writeFile("calavera.config.json", `${JSON.stringify(recipeWith([]), null, 2)}\n`);
    const before = await snapshotDirectory();
    const registry = cachingRegistry();

    const result = await runArtifactCommand(
      artifactOptions("status", { checkUpdates: true }),
      registry,
    );

    assert.deepEqual(registry.requests, []);
    assert.deepEqual(result.ignoreChanges, []);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("artifacts status --check-updates writes the block for lock entries the recipe no longer selects", async () => {
  await inProject(undefined, async () => {
    await lockedProject();
    await rm(".calavera/cache", { recursive: true, force: true });
    await writeFile("calavera.config.json", `${JSON.stringify(recipeWith([]), null, 2)}\n`);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify({ ...state, gitignoreBlocks: [fixtureRecord] })}\n`,
    );

    const result = await runArtifactCommand(
      artifactOptions("status", { checkUpdates: true }),
      cachingRegistry(),
    );

    assert.deepEqual(result.ignoreChanges, [cacheChange("update")]);
    assert.equal(
      await readFile(".gitignore", "utf8"),
      `node_modules/\n${fixtureBlock}${cacheBlock}`,
    );
  });
});

test("artifacts status --check-updates writes the block for a selection that is not locked yet", async () => {
  await inProject("node_modules/\n", async () => {
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify(recipeWith(["skill-project-goal"]), null, 2)}\n`,
    );
    // ADR-0020, Decision 1: --check-updates records the cache block only with a state file, so the
    // project gets one, as artifacts install or --init would write it.
    await mkdir(".calavera", { recursive: true });
    await writeFile(".calavera/state.json", `${JSON.stringify({ version: 1 }, null, 2)}\n`);

    const result = await runArtifactCommand(
      artifactOptions("status", { checkUpdates: true }),
      cachingRegistry(),
    );

    assert.deepEqual(result.ignoreChanges, [cacheChange("update")]);
    assert.equal(await readFile(".gitignore", "utf8"), `node_modules/\n${cacheBlock}`);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.gitignoreBlocks, [cacheRecord]);
  });
});

for (const { name, options, setup } of commands) {
  test(`${name} keeps the cache out of Git when the registry fails after filling it`, async () => {
    await inProject(`node_modules/\n${fixtureBlock}`, async () => {
      git(["init", "--quiet"]);
      await setup();
      await writeFile(".gitignore", `node_modules/\n${fixtureBlock}`);
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...state, gitignoreBlocks: [fixtureRecord] })}\n`,
      );
      // npm writes into its cache before a network failure surfaces.
      const failing = {
        ...cachingRegistry(),
        resolve: async (/** @type {{ cache: string }} */ request) => {
          await mkdir(join(request.cache, "content-v2"), { recursive: true });
          await writeFile(join(request.cache, "content-v2", "entry"), "cached\n");
          throw new Error("registry unreachable");
        },
      };

      await assert.rejects(runArtifactCommand(options, failing), /registry unreachable/);

      assert.equal(
        await readFile(".gitignore", "utf8"),
        `node_modules/\n${fixtureBlock}${cacheBlock}`,
      );
      const untracked = git(["status", "--porcelain", "--untracked-files=all"]).split("\n");
      assert.deepEqual(
        untracked.filter((line) => line.includes(".calavera/cache")),
        [],
      );
    });
  });

  test(`${name} records a cache block that is already in the file without a record`, async () => {
    await inProject(undefined, async () => {
      await setup();
      await writeFile(".gitignore", `node_modules/\n${cacheBlock}`);
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...state, gitignoreBlocks: [] })}\n`,
      );
      const { ino } = await stat(".gitignore");

      const result = await runArtifactCommand(options, cachingRegistry());

      assert.deepEqual(result.ignoreChanges, [cacheChange("unchanged")]);
      assert.equal((await stat(".gitignore")).ino, ino);
      const written = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      assert.deepEqual(written.gitignoreBlocks, [cacheRecord]);
    });
  });
}

for (const { name, rerun, options, setup } of commands) {
  test(`${name} names itself, not apply, when a cache block marker is broken`, async () => {
    await inProject(undefined, async () => {
      await setup();
      // A start marker without its end marker, so Calavera cannot tell where the block ends.
      await writeFile(
        ".gitignore",
        "node_modules/\n# calavera:artifact-cache:start\n.calavera/cache/\n",
      );

      for (const dryRun of [true, false]) {
        await assert.rejects(
          runArtifactCommand({ ...options, dryRun }, cachingRegistry()),
          (/** @type {Error} */ error) => {
            assert.match(error.message, /has a start marker without an end marker/);
            assert.ok(error.message.includes(`and run ${rerun} again.`), error.message);
            assert.doesNotMatch(error.message, /run apply again/);
            return true;
          },
        );
      }
    });
  });

  // #838: the dry run stops where the command would, so it formats the state it would record.
  test(`${name} --dry-run stops where the command does when the formatter cannot load`, async () => {
    await inProject(`node_modules/\n${fixtureBlock}`, async () => {
      await setup();
      await writeFile(".gitignore", `node_modules/\n${fixtureBlock}`);
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      await writeFile(
        ".calavera/state.json",
        `${JSON.stringify({ ...state, gitignoreBlocks: [fixtureRecord] })}\n`,
      );
      const before = await snapshotDirectory();

      for (const dryRun of [true, false]) {
        const registry = cachingRegistry();
        await assert.rejects(
          runArtifactCommand(
            { ...options, dryRun },
            {
              ...registry,
              loadFormatter: async () => {
                throw new Error("the project formatter cannot load");
              },
            },
          ),
          /the project formatter cannot load/,
        );
        assert.deepEqual(registry.requests, [], `dryRun: ${dryRun}`);
      }
      assert.deepEqual(await snapshotDirectory(), before);
    });
  });
}
