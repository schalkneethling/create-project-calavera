import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runArtifactCommand } from "../../../packages/cli/src/artifact-lifecycle.js";
import { buildRecipe } from "../../../packages/cli/src/recipe.js";
import {
  inspectAppUpdate,
  inspectUpdates,
  recipePath,
  snapshotDiagnostics,
  unseenUpdates,
} from "../src/update-core.js";

const fetcher = async () => ({
  ok: true,
  json: async () => ({ "dist-tags": { latest: "2.0.0", next: "3.0.0-beta.1" } }),
});

test("checks multiple locked components and prepares exact non-executed commands", async () => {
  const updates = await inspectUpdates(
    { path: "/project", tag: "latest", cliVersion: "1.0.0" },
    {
      recipe: buildRecipe("minimal", [], "npm"),
      lock: {
        artifacts: [
          { id: "skill-project-goal", package: "example", version: "1.0.0", tag: "latest" },
        ],
      },
    },
    fetcher,
  );
  assert.equal(updates.length, 2);
  assert.equal(
    updates[0].command,
    "npm create project-calavera artifacts update skill-project-goal",
  );
  assert.deepEqual(unseenUpdates(updates, [updates[0].key]), [updates[1]]);
});

test("quotes an artifact id the lock names for the shell", async () => {
  const [update] = await inspectUpdates(
    { path: "/project", tag: "latest" },
    {
      recipe: buildRecipe("minimal", [], "npm"),
      lock: {
        artifacts: [{ id: "artifact; malicious-command", package: "example", version: "1.0.0" }],
      },
    },
    fetcher,
  );
  assert.match(update.command, / artifacts update 'artifact; malicious-command'$/);
});

test("offers no update command without a readable recipe, as artifacts status does", async () => {
  const [update] = await inspectUpdates(
    { path: "/project", tag: "latest", config: "recipe/calavera.json" },
    {
      recipe: null,
      lock: {
        artifacts: [{ id: "skill-project-goal", package: "example", version: "1.0.0" }],
      },
    },
    fetcher,
  );
  assert.equal(update.available, "2.0.0");
  assert.equal(update.command, null);
});

test("uses an explicitly selected prerelease channel", async () => {
  const [update] = await inspectUpdates(
    { path: "/project", tag: "next" },
    {
      recipe: buildRecipe("minimal", [], "npm"),
      lock: {
        artifacts: [
          { id: "skill-project-goal", package: "example", version: "2.0.0", tag: "latest" },
        ],
      },
    },
    fetcher,
  );
  assert.equal(update.available, "3.0.0-beta.1");
  assert.match(update.command, / --tag next$/);
});

/**
 * Runs `callback` in a new project whose recipe at `config` selects `id` through `packageManager`
 * and whose lock holds `id` at `version` on `tag`, as `artifacts install` records it.
 *
 * @param {{ id: string, version: string, tag: "latest" | "next", packageManager: string, config: string }} setup
 * @param {(snapshot: { recipe: unknown, lock: unknown }) => Promise<void>} callback
 */
async function inProject({ id, version, tag, packageManager, config }, callback) {
  const originalDirectory = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "calavera-menu-bar-"));
  try {
    process.chdir(directory);
    const recipe = { ...buildRecipe("minimal", [], packageManager), ai: [{ id }] };
    const lock = {
      schemaVersion: 1,
      artifacts: [
        {
          id,
          type: "skill",
          package: `@schalkneethling/calavera-${id}`,
          version,
          tag,
          destination: `.agents/skills/${id}`,
        },
      ],
    };
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, `${JSON.stringify(recipe, null, 2)}\n`);
    await mkdir(".calavera", { recursive: true });
    await writeFile(".calavera/artifacts.lock.json", `${JSON.stringify(lock, null, 2)}\n`);
    await callback({ recipe, lock });
  } finally {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
}

// Issue #995: the menu-bar app copies the update command `artifacts status --json` reports, so it
// runs through the project's package manager and names a recipe saved outside the default path.
for (const setup of /** @type {const} */ ([
  { packageManager: "npm", config: "calavera.config.json", tag: "latest" },
  { packageManager: "npm", config: "recipes/calavera.json", tag: "latest" },
  { packageManager: "pnpm", config: "recipes/calavera.json", tag: "next" },
])) {
  test(`copies the update command artifacts status reports (${setup.packageManager}, ${setup.config}, ${setup.tag})`, async () => {
    const id = "skill-project-goal";
    await inProject({ id, version: "1.0.0", ...setup }, async (snapshot) => {
      const status = await runArtifactCommand(
        { config: setup.config, dryRun: false, artifactAction: "status", checkUpdates: true },
        {
          resolve: async ({ tag }) => ({ version: "2.0.0", tag, repository: null }),
          extract: async () => {
            throw new Error("Status never extracts a package.");
          },
        },
      );
      const [statusEntry] = status.artifacts;
      assert.ok(statusEntry.updateCommand);

      const [update] = await inspectUpdates(
        { path: process.cwd(), tag: setup.tag, config: setup.config },
        snapshot,
        async () => ({ ok: true, json: async () => ({ "dist-tags": { [setup.tag]: "2.0.0" } }) }),
      );
      assert.equal(update.command, statusEntry.updateCommand);
    });
  });
}

test("compares the app version with stable GitHub releases", async () => {
  const update = await inspectAppUpdate("0.1.0", async () => ({
    ok: true,
    json: async () => [
      { tag_name: "menu-bar-v0.2.0", draft: true },
      {
        tag_name: "menu-bar-v0.1.1",
        draft: false,
        prerelease: false,
        html_url:
          "https://github.com/schalkneethling/create-project-calavera/releases/tag/menu-bar-v0.1.1",
      },
      {
        tag_name: "menu-bar-v0.3.0",
        draft: false,
        prerelease: false,
        html_url:
          "https://github.com/schalkneethling/create-project-calavera/releases/tag/menu-bar-v0.3.0",
      },
      {
        tag_name: "menu-bar-v0.2.0",
        draft: false,
        prerelease: false,
        html_url:
          "https://github.com/schalkneethling/create-project-calavera/releases/tag/menu-bar-v0.2.0",
      },
    ],
  }));
  assert.equal(update.available, "0.3.0");
  assert.equal(update.kind, "app");
});

test("names missing and incompatible project-state components", () => {
  assert.deepEqual(snapshotDiagnostics({ recipe: null, lock: null, state: null }), [
    "Missing recipe (calavera.config.json)",
    "Missing artifact lock (.calavera/artifacts.lock.json)",
    "Missing managed state (.calavera/state.json)",
  ]);
  assert.deepEqual(
    snapshotDiagnostics({
      recipe: { version: 1, integrations: [], scripts: {} },
      lock: { schemaVersion: 2, artifacts: [] },
      state: { version: 1, managedFiles: [], aiArtifacts: [] },
    }),
    ["Incompatible artifact lock (.calavera/artifacts.lock.json)"],
  );
  assert.deepEqual(
    snapshotDiagnostics(
      {
        recipe: null,
        lock: { schemaVersion: 1, artifacts: [] },
        state: { version: 1, managedFiles: [], aiArtifacts: [] },
      },
      "recipes/calavera.json",
    ),
    ["Missing recipe (recipes/calavera.json)"],
  );
});

test("an unreadable recipe is named with its cause, and its updates stay listed without a command", async () => {
  const snapshot = {
    recipe: null,
    recipeError: "key must be a string at line 1 column 3",
    lock: {
      schemaVersion: 1,
      artifacts: [{ id: "skill-project-goal", package: "example", version: "1.0.0" }],
    },
    state: { version: 1, managedFiles: [], aiArtifacts: [] },
  };
  assert.deepEqual(snapshotDiagnostics(snapshot, "recipes/calavera.json"), [
    "Unreadable recipe (recipes/calavera.json): key must be a string at line 1 column 3",
  ]);
  const [update] = await inspectUpdates(
    { path: "/project", tag: "latest", config: "recipes/calavera.json" },
    snapshot,
    fetcher,
  );
  assert.equal(update.available, "2.0.0");
  assert.equal(update.command, null);
});

test("a project registered without a recipe path reads the default recipe", () => {
  assert.equal(recipePath({ path: "/project" }), "calavera.config.json");
  assert.equal(
    recipePath({ path: "/project", config: "recipes/calavera.json" }),
    "recipes/calavera.json",
  );
});
