// #1193 (owner decision of 2026-11-23): `artifacts install` and `artifacts update` refuse to write
// through a symbolic link on the path of anything the artifact transaction writes, before they
// change anything, because the rollback refuses such a journal and Calavera never writes outside
// the project through a link. The message names the link and tells the person to replace it with
// a real folder.
import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { aiArtifactOutputPaths } from "../src/ai/artifacts.js";
import {
  PACKAGE_PATH,
  prepareArtifactSources,
  readArtifactStatus,
  runArtifactCommand,
} from "../src/artifact-lifecycle.js";
import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";

/** The message that refuses a write through the symbolic link at the project path `link`. */
function refusal(/** @type {string} */ link) {
  return `Calavera does not write artifacts through the symbolic link ${link}. Replace ${link} with a real folder, then run the command again.`;
}

// Each linked folder, and an artifact whose install writes below it.
const CASES = [
  { link: ".agents", item: { id: "skill-code-review" } },
  { link: ".agents/skills", item: { id: "skill-code-review" } },
  { link: ".agents/hooks", item: { id: "hook-block-dangerous-commands", target: "claude-code" } },
  {
    link: ".agents/agents",
    item: { id: "agent-technical-devils-advocate", target: "claude-code" },
  },
  { link: ".codex", item: { id: "agent-technical-devils-advocate", target: "codex" } },
  { link: ".calavera/packages", item: { id: "skill-code-review" } },
  { link: ".calavera", item: { id: "skill-code-review" } },
  { link: ".calavera/.transactions", item: { id: "skill-code-review" } },
];

/**
 * Runs `callback` in a new project whose recipe selects `item`, with a separate folder outside the
 * project for the link to point to.
 *
 * @param {{ id: string, target?: string }} item
 * @param {(paths: { project: string, outside: string }) => Promise<void>} callback
 */
async function inProject(item, callback) {
  const originalDirectory = process.cwd();
  const project = await realpath(await mkdtemp(join(tmpdir(), "calavera-linked-folder-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-linked-outside-")));
  try {
    process.chdir(project);
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: [item] }, null, 2)}\n`,
    );
    await callback({ project, outside });
  } finally {
    process.chdir(originalDirectory);
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

/** @param {"install" | "update"} artifactAction @param {string} id */
function options(artifactAction, id) {
  return {
    config: "calavera.config.json",
    dryRun: false,
    artifactAction,
    ...(artifactAction === "update" ? { artifactId: id } : {}),
  };
}

for (const { link, item } of CASES) {
  test(`artifacts install refuses to write through a linked ${link} and changes nothing`, async () => {
    await inProject(item, async ({ project, outside }) => {
      await mkdir(dirname(join(project, link)), { recursive: true });
      await symlink(outside, join(project, link));
      const projectBefore = await snapshotDirectory(project);
      const outsideBefore = await snapshotDirectory(outside);

      await assert.rejects(
        runArtifactCommand(
          options("install", item.id),
          stubRegistry(new Map([[item.id, "1.0.0"]])),
        ),
        { message: refusal(link) },
      );

      assert.deepEqual(await snapshotDirectory(project), projectBefore);
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    });
  });

  test(`artifacts update refuses to write through a linked ${link} and changes nothing`, async () => {
    await inProject(item, async ({ project, outside }) => {
      await runArtifactCommand(
        options("install", item.id),
        stubRegistry(new Map([[item.id, "1.0.0"]])),
      );
      // The installed folder moves outside the project, and a link takes its place. An install
      // that finished leaves no staging, so the transaction folder may not exist yet.
      await mkdir(join(project, link), { recursive: true });
      await cp(join(project, link), outside, { recursive: true, verbatimSymlinks: true });
      await rm(join(project, link), { recursive: true });
      await symlink(outside, join(project, link));
      const projectBefore = await snapshotDirectory(project);
      const outsideBefore = await snapshotDirectory(outside);

      await assert.rejects(
        runArtifactCommand(options("update", item.id), stubRegistry(new Map([[item.id, "2.0.0"]]))),
        { message: refusal(link) },
      );

      assert.deepEqual(await snapshotDirectory(project), projectBefore);
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    });
  });
}

// The artifact cache block that `artifacts status --check-updates` records commits through the
// same transaction, into `.calavera/state.json` and `.gitignore`, so a linked `.calavera` stops it
// before it stages anything.
test("artifacts status --check-updates refuses to record the cache block through a linked .calavera", async () => {
  await inProject({ id: "skill-code-review" }, async ({ project, outside }) => {
    // ADR-0020, Decision 1: --check-updates records the cache block only with a state file, so the
    // project gets one, as artifacts install or --init would write it.
    await writeFile(join(outside, "state.json"), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    await symlink(outside, join(project, ".calavera"));
    const projectBefore = await snapshotDirectory(project);
    const outsideBefore = await snapshotDirectory(outside);

    await assert.rejects(
      runArtifactCommand(
        {
          config: "calavera.config.json",
          dryRun: false,
          artifactAction: "status",
          checkUpdates: true,
        },
        stubRegistry(new Map([["skill-code-review", "1.0.0"]])),
      ),
      { message: refusal(".calavera") },
    );

    assert.deepEqual(await snapshotDirectory(project), projectBefore);
    assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
  });
});

// Apply installs the artifacts its recipe selects that are not locked yet through the same staging
// and commit, so a linked folder stops it before it resolves, caches, or stages any package.
for (const link of [".agents", ".calavera", ".calavera/.transactions"]) {
  test(`apply refuses to install an unlocked artifact through a linked ${link} before it resolves anything`, async () => {
    const item = { id: "skill-code-review" };
    await inProject(item, async ({ project, outside }) => {
      await mkdir(dirname(join(project, link)), { recursive: true });
      await symlink(outside, join(project, link));
      const projectBefore = await snapshotDirectory(project);
      const outsideBefore = await snapshotDirectory(outside);
      const registry = stubRegistry(new Map([[item.id, "1.0.0"]]));

      await assert.rejects(
        prepareArtifactSources(
          { ...buildRecipe("minimal", [], "npm"), ai: [item] },
          false,
          registry,
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(refusal(link)), error.message);
          return true;
        },
      );

      assert.deepEqual(registry.requests, []);
      assert.deepEqual(await snapshotDirectory(project), projectBefore);
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    });
  });
}

// A dry run stops where the install would, with the same message, and writes nothing either.
test("artifacts install --dry-run refuses a linked .agents/skills like the install", async () => {
  const item = { id: "skill-code-review" };
  await inProject(item, async ({ project, outside }) => {
    await mkdir(join(project, ".agents"));
    await symlink(outside, join(project, ".agents/skills"));
    const projectBefore = await snapshotDirectory(project);
    const registry = stubRegistry(new Map([[item.id, "1.0.0"]]));

    await assert.rejects(
      runArtifactCommand({ ...options("install", item.id), dryRun: true }, registry),
      { message: refusal(".agents/skills") },
    );

    assert.deepEqual(registry.requests, []);
    assert.deepEqual(await snapshotDirectory(project), projectBefore);
  });
});

// A link whose target is missing still counts as the person's folder, so apply's cleanup after
// the refusal leaves it in place instead of removing it as a folder the attempt created.
for (const link of [".agents", ".calavera"]) {
  test(`apply keeps a dangling ${link} link after it refuses to install through it`, async () => {
    const item = { id: "skill-code-review" };
    await inProject(item, async ({ project, outside }) => {
      await symlink(join(outside, "missing"), join(project, link));
      const projectBefore = await snapshotDirectory(project);

      await assert.rejects(
        prepareArtifactSources(
          { ...buildRecipe("minimal", [], "npm"), ai: [item] },
          false,
          stubRegistry(new Map([[item.id, "1.0.0"]])),
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(refusal(link)), error.message);
          assert.doesNotMatch(error.message, /Removing the directories/);
          return true;
        },
      );

      assert.deepEqual(await snapshotDirectory(project), projectBefore);
    });
  });
}

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

/**
 * Applies `recipe` once, so every selection is locked, then moves the project folder `link` to
 * `outside` and puts a symbolic link to it in its place. The locked packages and the artifact
 * outputs are removed, so the next apply rebuilds each package and writes each output again.
 *
 * @param {string} project
 * @param {string} outside
 * @param {string} link
 * @param {{ ai: unknown[] }} recipe
 * @param {ReturnType<typeof stubRegistry>} registry
 */
async function lockThenLink(project, outside, link, recipe, registry) {
  await writeFile("package.json", `${JSON.stringify({ name: "linked", private: true })}\n`);
  await applyRecipeObject(recipe, applyOptions, registry);
  const lock = JSON.parse(await readFile(".calavera/artifacts.lock.json", "utf8"));
  for (const entry of lock.artifacts) {
    await rm(join(PACKAGE_PATH, entry.id), { recursive: true, force: true });
    for (const path of aiArtifactOutputPaths({ type: entry.type, path: entry.destination })) {
      await rm(path, { recursive: true, force: true });
    }
  }
  await mkdir(join(project, link), { recursive: true });
  await cp(join(project, link), outside, { recursive: true, verbatimSymlinks: true });
  await rm(join(project, link), { recursive: true });
  await symlink(outside, join(project, link));
}

// #1209: when every selection is locked, apply rebuilds a missing package into
// `.calavera/packages` and writes the outputs itself, without an artifact transaction, so it
// refuses the same links before it writes anything. Its dry run stops with the same message.
for (const { link, item } of CASES) {
  for (const dryRun of [false, true]) {
    test(`apply${dryRun ? " --dry-run" : ""} with every artifact locked refuses to write through a linked ${link} and changes nothing`, async () => {
      await inProject(item, async ({ project, outside }) => {
        const recipe = { ...buildRecipe("minimal", [], "npm"), ai: [item] };
        const registry = stubRegistry(new Map([[item.id, "1.0.0"]]));
        await lockThenLink(project, outside, link, recipe, registry);
        const projectBefore = await snapshotDirectory(project);
        const outsideBefore = await snapshotDirectory(outside);

        await assert.rejects(applyRecipeObject(recipe, { ...applyOptions, dryRun }, registry), {
          message: refusal(link),
        });

        assert.deepEqual(await snapshotDirectory(project), projectBefore);
        assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
      });
    });
  }
}

// #1209: apply that installs an unlocked selection also writes the outputs of the locked ones
// itself, so a link below only a locked selection's output stops it before the install commits.
test("apply refuses a linked folder that only a locked selection writes into before it installs the unlocked one", async () => {
  const locked = { id: "hook-block-dangerous-commands", target: "claude-code" };
  const unlocked = { id: "skill-code-review" };
  await inProject(locked, async ({ project, outside }) => {
    const registry = stubRegistry(
      new Map([
        [locked.id, "1.0.0"],
        [unlocked.id, "1.0.0"],
      ]),
    );
    await lockThenLink(
      project,
      outside,
      ".agents/hooks",
      { ...buildRecipe("minimal", [], "npm"), ai: [locked] },
      registry,
    );
    const projectBefore = await snapshotDirectory(project);
    const outsideBefore = await snapshotDirectory(outside);

    await assert.rejects(
      applyRecipeObject(
        { ...buildRecipe("minimal", [], "npm"), ai: [locked, unlocked] },
        applyOptions,
        registry,
      ),
      { message: refusal(".agents/hooks") },
    );

    assert.deepEqual(await snapshotDirectory(project), projectBefore);
    assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
  });
});

// #1209: `artifacts status --check-updates` fills the registry cache in `.calavera/cache` even when
// the cache block is already recorded and no record changes, so a linked `.calavera` stops it too.
for (const dryRun of [false, true]) {
  test(`artifacts status --check-updates${dryRun ? " --dry-run" : ""} refuses a linked .calavera when the cache block is already recorded`, async () => {
    const item = { id: "skill-code-review" };
    await inProject(item, async ({ project, outside }) => {
      const registry = stubRegistry(new Map([[item.id, "1.0.0"]]));
      await runArtifactCommand(options("install", item.id), registry);
      await cp(join(project, ".calavera"), outside, { recursive: true, verbatimSymlinks: true });
      await rm(join(project, ".calavera"), { recursive: true });
      await symlink(outside, join(project, ".calavera"));
      const projectBefore = await snapshotDirectory(project);
      const outsideBefore = await snapshotDirectory(outside);

      await assert.rejects(
        runArtifactCommand(
          {
            config: "calavera.config.json",
            dryRun,
            artifactAction: "status",
            checkUpdates: true,
          },
          registry,
        ),
        { message: refusal(".calavera") },
      );

      assert.deepEqual(await snapshotDirectory(project), projectBefore);
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    });
  });
}

// #1193: when the cache block is not recorded yet, `artifacts status --check-updates` stages the
// state it records in `.calavera/.transactions`, so a link there stops the report before it stages
// anything, although `.calavera` itself is a real folder. The link target is read-only, so a
// staging write that the transaction refused and cleaned up afterward fails with a different error.
test("artifacts status --check-updates refuses to record the cache block through a linked .calavera/.transactions", async () => {
  await inProject({ id: "skill-code-review" }, async ({ project, outside }) => {
    await mkdir(join(project, ".calavera"));
    // ADR-0020, Decision 1: --check-updates records the cache block only with a state file, so the
    // project gets one, as artifacts install or --init would write it.
    await writeFile(
      join(project, ".calavera/state.json"),
      `${JSON.stringify({ version: 1 }, null, 2)}\n`,
    );
    await symlink(outside, join(project, ".calavera/.transactions"));
    await chmod(outside, 0o555);
    const projectBefore = await snapshotDirectory(project);
    const outsideBefore = await snapshotDirectory(outside);

    await assert.rejects(
      runArtifactCommand(
        {
          config: "calavera.config.json",
          dryRun: false,
          artifactAction: "status",
          checkUpdates: true,
        },
        stubRegistry(new Map([["skill-code-review", "1.0.0"]])),
      ),
      { message: refusal(".calavera/.transactions") },
    );

    assert.deepEqual(await snapshotDirectory(project), projectBefore);
    assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    await chmod(outside, 0o755);
  });
});

// #1209: a recipe without AI items writes no artifact, so apply does not check the artifact
// folders, and a linked `.calavera/.transactions`, which such an apply never writes into, stays
// as it is.
test("apply of a recipe without AI items does not refuse a linked .calavera/.transactions", async () => {
  await inProject({ id: "skill-code-review" }, async ({ project, outside }) => {
    await writeFile("package.json", `${JSON.stringify({ name: "linked", private: true })}\n`);
    await mkdir(join(project, ".calavera"));
    await symlink(outside, join(project, ".calavera/.transactions"));
    const outsideBefore = await snapshotDirectory(outside);

    await applyRecipeObject({ ...buildRecipe("minimal", [], "npm"), ai: [] }, applyOptions, {});

    assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
  });
});

// #1209: the read-only report (#1052) and a report without `--check-updates` write no cache, so a
// linked `.calavera` does not stop them.
for (const { name, run } of [
  {
    name: "the read-only artifacts status --check-updates",
    run: (/** @type {ReturnType<typeof stubRegistry>} */ registry) =>
      readArtifactStatus({ config: "calavera.config.json", checkUpdates: true }, registry),
  },
  {
    name: "artifacts status without --check-updates",
    run: (/** @type {ReturnType<typeof stubRegistry>} */ registry) =>
      runArtifactCommand(
        { config: "calavera.config.json", dryRun: false, artifactAction: "status" },
        registry,
      ),
  },
]) {
  test(`${name} does not refuse a linked .calavera`, async () => {
    const item = { id: "skill-code-review" };
    await inProject(item, async ({ project, outside }) => {
      const registry = stubRegistry(new Map([[item.id, "1.0.0"]]));
      await runArtifactCommand(options("install", item.id), registry);
      await cp(join(project, ".calavera"), outside, { recursive: true, verbatimSymlinks: true });
      await rm(join(project, ".calavera"), { recursive: true });
      await symlink(outside, join(project, ".calavera"));
      const projectBefore = await snapshotDirectory(project);
      const outsideBefore = await snapshotDirectory(outside);

      await run(registry);

      assert.deepEqual(await snapshotDirectory(project), projectBefore);
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    });
  });
}
