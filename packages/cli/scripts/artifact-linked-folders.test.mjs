// #1193 (owner decision of 2026-11-23): `artifacts install` and `artifacts update` refuse to write
// through a symbolic link on the path of anything the artifact transaction writes, before they
// change anything, because the rollback refuses such a journal and Calavera never writes outside
// the project through a link. The message names the link and tells the person to replace it with
// a real folder.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { prepareArtifactSources, runArtifactCommand } from "../src/artifact-lifecycle.js";
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
      // The installed folder moves outside the project, and a link takes its place.
      await mkdir(dirname(join(project, link)), { recursive: true });
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
for (const link of [".agents", ".calavera"]) {
  test(`apply refuses to install an unlocked artifact through a linked ${link} before it resolves anything`, async () => {
    const item = { id: "skill-code-review" };
    await inProject(item, async ({ project, outside }) => {
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
