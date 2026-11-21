// Issue #1125: a legacy AI entry (`{ "type": "skill", "src": "skills/protected-branch-guard" }`)
// cannot record the inputs an artifact declares, and apply planned wiring by the entry's legacy
// path, which no wiring record names. So apply never wired the artifact such an entry selects, and
// when a recipe switched from the ID entry to the legacy entry, the next apply removed the wiring
// that clean and doctor keep since #1101 and #1119. Owner decision (2026-11-21): apply, its dry
// run, and MCP dry_run_apply refuse such an entry before writing anything, name it, and point to
// `artifacts migrate`. A legacy entry for an artifact with no wiring or inputs applies as before.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertNoLegacyEntryNeedsWiring } from "../src/ai/recipe-items.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const GUARD_ID = "skill-protected-branch-guard";
const GUARD_LEGACY_ENTRY = { type: "skill", src: "skills/protected-branch-guard" };
const PROJECT_GOAL_ID = "skill-project-goal";
const WIRED_FILES = [
  ".vite-hooks/pre-commit",
  ".vite-hooks/prepare-commit-msg",
  ".vite-hooks/pre-push",
  ".claude/settings.json",
];
const REFUSAL =
  /ai\[0\] \{"type":"skill","src":"skills\/protected-branch-guard"\}[\s\S]*skill-protected-branch-guard[\s\S]*create-project-calavera artifacts migrate/;

/** @param {object[]} ai */
function recipeWith(ai) {
  return { ...buildRecipe("minimal", [], "npm"), ai };
}

/** @param {object} recipe */
async function writeRecipe(recipe) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
}

function registry() {
  return stubRegistry(
    new Map([
      [GUARD_ID, "0.1.0"],
      [PROJECT_GOAL_ID, "0.1.0"],
    ]),
  );
}

/**
 * Runs `callback` in a new Git repository on a feature branch with a package.json.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-apply-legacy-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"]);
    execFileSync("git", ["switch", "--quiet", "-c", "1125-legacy"]);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * Runs `callback` after apply installed and wired the protected branch guard, selected by its
 * catalog ID, and the recipe then switched to the guard's legacy entry.
 *
 * @param {() => Promise<void>} callback
 */
async function inWiredProjectWithLegacyEntry(callback) {
  await inProject(async () => {
    await callMcpTool(
      "apply_recipe",
      {
        recipe: recipeWith([{ id: GUARD_ID, inputs: { protectedBranch: "main" } }]),
        noInstall: true,
      },
      registry(),
    );
    await writeRecipe(recipeWith([GUARD_LEGACY_ENTRY]));
    await callback();
  });
}

/** @param {string[]} args */
function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/** Every file a refused apply must leave as it was. */
async function snapshot() {
  return Promise.all(
    [...WIRED_FILES, "calavera.config.json", ".calavera/state.json", "package.json"].map((path) =>
      readFile(path, "utf8"),
    ),
  );
}

for (const args of [
  ["apply", "--yes", "--json", "--no-install"],
  ["apply", "--dry-run", "--json"],
]) {
  test(`Given the recipe switched to the guard's legacy entry, ${args.slice(0, 2).join(" ")} refuses it before writing and names artifacts migrate`, async () => {
    await inWiredProjectWithLegacyEntry(async () => {
      const before = await snapshot();

      const result = runCli(args);
      assert.notEqual(
        result.status,
        0,
        `apply exited 0, so it did not refuse the legacy entry\n${result.stdout}`,
      );
      assert.match(result.stderr, REFUSAL);
      assert.match(result.stderr, /stopped before writing anything/);
      assert.deepEqual(await snapshot(), before);
    });
  });
}

test("Given the guard's legacy entry, MCP dry_run_apply and apply_recipe give the same refusal", async () => {
  await inWiredProjectWithLegacyEntry(async () => {
    const before = await snapshot();
    const recipe = recipeWith([GUARD_LEGACY_ENTRY]);

    await assert.rejects(callMcpTool("dry_run_apply", { recipe }, registry()), REFUSAL);
    await assert.rejects(
      callMcpTool("apply_recipe", { recipe, noInstall: true }, registry()),
      REFUSAL,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the guard's legacy entry in a project without wiring, apply refuses it before writing", async () => {
  await inProject(async () => {
    await assert.rejects(
      callMcpTool(
        "apply_recipe",
        { recipe: recipeWith([GUARD_LEGACY_ENTRY]), noInstall: true },
        registry(),
      ),
      REFUSAL,
    );
    assert.equal(
      spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })
        .stdout,
      "?? package.json\n",
    );
  });
});

test("Given a legacy entry for an artifact with no wiring or inputs, apply installs it as before", async () => {
  await inProject(async () => {
    const { result } = await callMcpTool(
      "apply_recipe",
      { recipe: recipeWith([{ type: "skill", src: "skills/project-goal" }]), noInstall: true },
      registry(),
    );
    assert.deepEqual(
      result.autoInstalledArtifacts.map((/** @type {{ id: string }} */ { id }) => id),
      [PROJECT_GOAL_ID],
    );
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.aiWiring, []);
  });
});

test("Given the guard's legacy entry, artifacts migrate and then apply wire the guard", async () => {
  await inProject(async () => {
    await writeRecipe(recipeWith([GUARD_LEGACY_ENTRY]));

    const migrate = runCli(["artifacts", "migrate", "--json"]);
    assert.equal(migrate.status, 0, `${migrate.stdout}\n${migrate.stderr}`);
    const migrated = JSON.parse(await readFile("calavera.config.json", "utf8"));
    assert.deepEqual(migrated.ai, [{ id: GUARD_ID }]);

    // The migrated entry can record the guard's input, which apply needs, as no default is known
    // in a repository without commits.
    migrated.ai[0].inputs = { protectedBranch: "main" };
    await callMcpTool("apply_recipe", { recipe: migrated, noInstall: true }, registry());

    const [preCommit] = await Promise.all(WIRED_FILES.map((path) => readFile(path, "utf8")));
    assert.match(preCommit, /protected-branch-guard\/scripts\/guard\.mjs commit main/);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(
      state.aiWiring.map((/** @type {{ artifact: string }} */ { artifact }) => artifact),
      [GUARD_ID],
    );
  });
});

test("The refusal names each legacy entry that needs wiring or inputs, by index, and no other entry", () => {
  assert.throws(
    () =>
      assertNoLegacyEntryNeedsWiring([
        { type: "skill", src: "skills/project-goal" },
        { type: "skill", src: " skills/protected-branch-guard " },
        { id: "skill-code-review" },
      ]),
    {
      message: [
        "Calavera stopped before writing anything, because these legacy AI entries select artifacts that need wiring or inputs:",
        '- ai[1] {"type":"skill","src":"skills/protected-branch-guard"} selects skill-protected-branch-guard by its legacy type and src, and skill-protected-branch-guard needs wiring and inputs, which a legacy entry cannot record.',
        "Run create-project-calavera artifacts migrate, which rewrites each legacy entry as an ID entry, then run apply again.",
      ].join("\n"),
    },
  );
  assert.doesNotThrow(() =>
    assertNoLegacyEntryNeedsWiring([
      { type: "skill", src: "skills/project-goal" },
      { id: GUARD_ID, inputs: { protectedBranch: "main" } },
    ]),
  );
  assert.doesNotThrow(() => assertNoLegacyEntryNeedsWiring(undefined));
});
