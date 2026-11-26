// #1007: `--init` installs the base Calavera skill in `.agents/skills/calavera` and records it in
// `.calavera/state.json`. `clean` removes only stale output, and the base skill is never stale,
// whether `--init` or a recipe installed it: it is Calavera's own artifact, whatever the recipe
// selects, as ADR-0017 (Decision 2, owner answer 7 on #678) also counts it. Only `eject` removes
// it. Every other artifact a recipe selected and then dropped is still stale, so `clean` keeps
// removing it when it is unedited (#829).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";
import { createTemporaryFixture } from "./vite-plus-fixtures.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const baseSkill = ".agents/skills/calavera";
const droppedId = "skill-project-goal";
const droppedSkill = ".agents/skills/project-goal";
const registry = () => stubRegistry(new Map([[droppedId, "0.1.0"]]));

/** @param {string[]} args */
function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<string[]>} */
async function recordedArtifactPaths() {
  const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
  return state.aiArtifacts.map((/** @type {{ path: string }} */ { path }) => path);
}

/** @param {unknown} recipe */
async function writeRecipe(recipe) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
}

/**
 * Runs `callback` in a new project that holds only a `package.json`, after `--init --yes`.
 *
 * @param {() => Promise<void>} callback
 */
async function inInitializedProject(callback) {
  await using fixture = await createTemporaryFixture("clean-base-skill", {
    "package.json": `${JSON.stringify({ name: "fixture" }, null, 2)}\n`,
  });
  const originalDirectory = process.cwd();
  process.chdir(fixture.root);
  try {
    runCli(["--init", "--yes", "--mcp-harness", "skip"]);
    assert.deepEqual(await recordedArtifactPaths(), [baseSkill]);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * The paths `clean --dry-run --json` would change.
 *
 * @returns {string[]}
 */
function cleanDryRunPaths() {
  const result = JSON.parse(runCli(["clean", "--dry-run", "--json"]));
  return [...result.changes, ...result.wiringChanges].map(
    (/** @type {{ path: string }} */ { path }) => path,
  );
}

test("Given --init and no recipe, clean --dry-run does not list the base skill, and clean --yes keeps it and its record", async () => {
  await inInitializedProject(async () => {
    assert.deepEqual(cleanDryRunPaths(), []);
    runCli(["clean", "--yes"]);
    assert.ok(await exists(`${baseSkill}/SKILL.md`));
    assert.deepEqual(await recordedArtifactPaths(), [baseSkill]);
  });
});

test("Given --init and an apply of a recipe that does not select the base skill, clean --dry-run does not list it, and clean --yes keeps it and its record", async () => {
  await inInitializedProject(async () => {
    const recipe = { ...buildRecipe("minimal", [], "npm"), ai: [{ id: droppedId }] };
    await writeRecipe(recipe);
    await callMcpTool("apply_recipe", { recipe, noInstall: true }, registry());
    assert.deepEqual((await recordedArtifactPaths()).toSorted(), [baseSkill, droppedSkill]);

    assert.deepEqual(cleanDryRunPaths(), []);
    runCli(["clean", "--yes"]);
    assert.ok(await exists(`${baseSkill}/SKILL.md`));
    assert.deepEqual((await recordedArtifactPaths()).toSorted(), [baseSkill, droppedSkill]);
  });
});

test("Given --init and a recipe that selected an artifact and then dropped it, clean still removes the unedited artifact and keeps the base skill", async () => {
  await inInitializedProject(async () => {
    const selecting = { ...buildRecipe("minimal", [], "npm"), ai: [{ id: droppedId }] };
    await callMcpTool("apply_recipe", { recipe: selecting, noInstall: true }, registry());
    assert.ok(await exists(droppedSkill));
    await writeRecipe({ ...selecting, ai: [] });

    assert.deepEqual(cleanDryRunPaths(), [droppedSkill]);
    runCli(["clean", "--yes"]);
    assert.equal(await exists(droppedSkill), false);
    assert.ok(await exists(`${baseSkill}/SKILL.md`));
    assert.deepEqual(await recordedArtifactPaths(), [baseSkill]);
  });
});

test("Given no --init and a recipe that selected skill-calavera and then dropped it, clean keeps the base skill and its record", async () => {
  await using fixture = await createTemporaryFixture("clean-base-skill-recipe", {
    "package.json": `${JSON.stringify({ name: "fixture" }, null, 2)}\n`,
  });
  const originalDirectory = process.cwd();
  process.chdir(fixture.root);
  try {
    const selecting = { ...buildRecipe("minimal", [], "npm"), ai: [{ id: "skill-calavera" }] };
    const releases = new Map([["skill-calavera", "0.2.5"]]);
    await callMcpTool(
      "apply_recipe",
      { recipe: selecting, noInstall: true },
      stubRegistry(releases),
    );
    assert.deepEqual(await recordedArtifactPaths(), [baseSkill]);
    await writeRecipe({ ...selecting, ai: [] });
    const before = await snapshot();

    assert.deepEqual(cleanDryRunPaths(), []);
    runCli(["clean", "--yes"]);
    assert.deepEqual(await snapshot(), before);
  } finally {
    process.chdir(originalDirectory);
  }
});
