// #1112 (ADR-0020, Decisions 1 to 3): the phase function classifies each managed file the recipe
// declares by the rule apply uses, with apply's planner and the project's formatter, and reads the
// wiring apply recorded. A managed file that apply wrote and someone deleted or edited drifts the
// project; a file the person owns at a managed path does not. A formatter that cannot load, or
// refuses a file, is a finding that names the file and the kind of failure, never a stop, and the
// files it was needed for are `not-checked`. The function stays read-only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readArtifactStatus, runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject } from "../src/index.js";
import { deriveProjectPhase } from "../src/project-phase.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";
import { writeVitePlusFormatter } from "./vite-plus-fixtures.mjs";

const CONFIG = "calavera.config.json";
const STATE = ".calavera/state.json";
const LOCK = ".calavera/artifacts.lock.json";
const EDITORCONFIG = ".editorconfig";
const KNIP = "knip.json";
const ARTIFACT = "skill-project-goal";
const applyOptions = { json: true, noInstall: true, assumeYes: true };
const registry = () => stubRegistry(new Map([[ARTIFACT, "0.1.0"]]));

/** @param {(directory: string) => Promise<void>} callback */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-phase-managed-"));
  const directory = await realpath(project.path);
  const originalDirectory = process.cwd();
  process.chdir(directory);
  try {
    await writeJsonFile("package.json", { scripts: {} });
    await callback(directory);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string[]} integrations @param {string[]} [ai] */
const recipeWith = (integrations, ai = []) => ({
  ...buildRecipe("minimal", integrations, "npm"),
  ai: ai.map((id) => ({ id })),
});

/** @param {string} path @param {unknown} value */
async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} path */
async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {string[]} integrations @param {string[]} [ai] */
async function applied(integrations, ai = []) {
  await writeJsonFile(CONFIG, recipeWith(integrations, ai));
  await applyRecipeObject(recipeWith(integrations, ai), applyOptions, registry());
}

/** Declares vite-plus in package.json, so the formatter apply uses is the project's vp fmt. */
async function declareVitePlus() {
  await writeJsonFile("package.json", { scripts: {}, devDependencies: { "vite-plus": "1.0.0" } });
}

const derive = () => deriveProjectPhase({ config: CONFIG });

/** @param {Awaited<ReturnType<typeof derive>>} result @param {string} path */
function fileCondition(result, path) {
  const file = result.managedFiles.find((item) => item.path === path);
  assert.ok(file, `no managed file ${path}`);
  return file.condition;
}

test("before apply, each declared managed file is pending", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, recipeWith(["editorconfig", "knip"]));
    const result = await derive();
    assert.equal(result.phase, "composed");
    assert.deepEqual(
      result.managedFiles.map(({ path, integration, condition }) => [path, integration, condition]),
      [
        [
          EDITORCONFIG,
          "editorconfig",
          { name: "pending", reason: `${EDITORCONFIG} does not exist yet, so apply writes it.` },
        ],
        [
          KNIP,
          "knip",
          { name: "pending", reason: `${KNIP} does not exist yet, so apply writes it.` },
        ],
      ],
    );
    assert.deepEqual(
      result.managedFiles.map(({ recorded }) => recorded),
      [false, false],
    );
    assert.deepEqual(result.formatterFailures, []);
    assert.equal(result.managedFilePlanProblem, null);
  });
});

test("apply makes every managed file current, and a deleted or edited one drifts the project", async () => {
  await inProject(async () => {
    await applied(["editorconfig", "knip"]);
    let result = await derive();
    assert.equal(result.phase, "applied");
    assert.deepEqual(fileCondition(result, KNIP), {
      name: "current",
      reason: `${KNIP} matches what the state records or what apply writes, so apply accepts it.`,
    });

    await rm(EDITORCONFIG);
    result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(fileCondition(result, EDITORCONFIG), {
      name: "missing",
      reason: `The state records ${EDITORCONFIG}, and it does not exist, so apply writes it again.`,
    });

    await applyRecipeObject(recipeWith(["editorconfig", "knip"]), applyOptions, registry());
    assert.equal((await derive()).phase, "applied");

    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(fileCondition(result, KNIP), {
      name: "edited",
      reason: `${KNIP} differs from what the state records and from what apply writes, so the next apply or update keeps it and stops on it.`,
    });
    assert.equal(result.managedFiles.find(({ path }) => path === KNIP)?.recorded, true);
  });
});

test("an edit apply accepts, such as equal JSON, keeps the file current", async () => {
  await inProject(async () => {
    await applied(["knip"]);
    const knip = await readJsonFile(KNIP);
    // The same values in another key order.
    const reordered = Object.fromEntries(Object.entries(knip).reverse());
    await writeFile(KNIP, JSON.stringify(reordered));
    const result = await derive();
    assert.equal(result.phase, "applied");
    assert.equal(fileCondition(result, KNIP).name, "current");
  });
});

test("the person's own file at a managed path is unrecorded and never drifts the project", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, recipeWith(["knip"]));
    await writeJsonFile(KNIP, { entry: ["src/main.ts"] });
    let result = await derive();
    assert.equal(result.phase, "composed");
    assert.deepEqual(fileCondition(result, KNIP), {
      name: "unrecorded",
      reason: `${KNIP} already exists without a state record and differs from what apply writes, so apply stops on it as not recorded as Calavera-managed.`,
    });

    // After apply, a newly declared file that already exists is unrecorded too (owner decision 22).
    await rm(KNIP);
    await applied([]);
    await writeJsonFile(CONFIG, recipeWith(["knip"]));
    await writeJsonFile(KNIP, { entry: ["src/main.ts"] });
    result = await derive();
    assert.equal(result.phase, "applied");
    assert.equal(fileCondition(result, KNIP).name, "unrecorded");
  });
});

test("a file without a record that matches what apply writes is current", async () => {
  await inProject(async () => {
    await applied(["knip"]);
    const state = await readJsonFile(STATE);
    state.managedFiles = [];
    await writeJsonFile(STATE, state);
    const result = await derive();
    assert.equal(fileCondition(result, KNIP).name, "current");
    assert.equal(result.phase, "applied");
  });
});

test("a managed file that cannot be read is unreadable and drifts the project", async () => {
  await inProject(async () => {
    await applied(["knip"]);
    await rm(KNIP);
    await mkdir(KNIP);
    const result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(fileCondition(result, KNIP), {
      name: "unreadable",
      reason: `Calavera cannot read ${KNIP} (EISDIR), so it cannot compare it with what apply writes.`,
    });
  });
});

test("an unreadable path with no record never drifts the project", async () => {
  await inProject(async () => {
    await applied([]);
    await writeJsonFile(CONFIG, recipeWith(["knip"]));
    await mkdir(KNIP);
    const result = await derive();
    assert.equal(fileCondition(result, KNIP).name, "unreadable");
    assert.equal(result.phase, "applied");
  });
});

test("formatter failures follow the plan order whichever format run ends first", async () => {
  await inProject(async (directory) => {
    await applied(["knip", "react-doctor"]);
    await declareVitePlus();
    await writeVitePlusFormatter(directory, { banner: "loaded" });
    const result = await derive();
    assert.equal(result.formatterFailures.length, 2);
    assert.deepEqual(
      result.formatterFailures.map(({ path }) => path),
      result.managedFiles.map(({ path }) => path),
    );
  });
});

test("a formatter that cannot load is a finding, and the files that need it are not-checked", async () => {
  await inProject(async () => {
    await applied(["editorconfig", "knip"]);
    // Vite+ declared but not installed: apply would stop on loading the formatter.
    await declareVitePlus();
    let result = await derive();
    assert.deepEqual(result.formatterFailures, [
      {
        path: null,
        kind: "not-installed",
        reason:
          "The project uses Vite+, but Calavera cannot find its vite-plus package, so it cannot format the managed files the way apply does, and apply stops on the same thing. Run vp install, then run the command again.",
      },
    ]);
    // An unedited file needs no formatter.
    assert.equal(fileCondition(result, KNIP).name, "current");
    assert.equal(result.phase, "applied");

    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    result = await derive();
    assert.deepEqual(fileCondition(result, KNIP), {
      name: "not-checked",
      reason: `Calavera could not format what apply writes for ${KNIP} (not-installed), so it cannot tell whether apply stops on it. The formatter failure gives the remedy.`,
    });
    // A not-checked file never drifts the project.
    assert.equal(result.phase, "applied");
    // A file the formatter is not used for is still classified.
    assert.equal(fileCondition(result, EDITORCONFIG).name, "current");
  });
});

test("the formatter loads on every run with a recipe, as apply's does, even with no managed file", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, recipeWith([]));
    await declareVitePlus();
    const result = await derive();
    assert.equal(result.phase, "composed");
    assert.deepEqual(
      result.formatterFailures.map(({ path, kind }) => [path, kind]),
      [[null, "not-installed"]],
    );
  });
});

test("a formatter that refuses one file names that file, and the other files are classified", async () => {
  await inProject(async (directory) => {
    await applied(["knip", "react-doctor"]);
    await declareVitePlus();
    await writeVitePlusFormatter(directory, { failFor: KNIP });
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    const result = await derive();
    assert.deepEqual(result.formatterFailures, [
      {
        path: KNIP,
        kind: "failed",
        reason: `vp fmt could not format ${KNIP}, so apply stops on the same thing. Calavera does not show vp fmt's output, because it can quote the file. Check that vite.config.ts loads without errors, which vp fmt --check in the project reports, then run the command again.`,
      },
    ]);
    assert.equal(
      fileCondition(result, KNIP).reason,
      `Calavera could not format what apply writes for ${KNIP} (failed), so it cannot tell whether apply stops on it. The formatter failure gives the remedy.`,
    );
    assert.equal(fileCondition(result, "react-doctor.config.json").name, "current");
  });
});

test("a formatter that prints output with the formatted text is a printed-output finding", async () => {
  await inProject(async (directory) => {
    await applied(["knip"]);
    await declareVitePlus();
    await writeVitePlusFormatter(directory, { banner: "dotenv loaded 3 secrets" });
    const result = await derive();
    assert.deepEqual(result.formatterFailures, [
      {
        path: KNIP,
        kind: "printed-output",
        reason: `vp fmt returned something with the formatted text of ${KNIP}, such as output that vite.config.ts printed, so apply stops on the same thing. Make vite.config.ts print nothing when it loads, then run the command again.`,
      },
    ]);
    // No reason quotes what the formatter printed.
    assert.equal(JSON.stringify(result).includes("dotenv"), false);
  });
});

const CONTROLS = "github-repository-controls";
const controlsRecipe = () =>
  buildRecipe("minimal", [CONTROLS], "npm", [], {
    [CONTROLS]: { repository: "example/phase", defaultBranch: "main" },
  });

test("a root-only integration's files in a workspace member are classified at the repository root", async () => {
  await inProject(async (directory) => {
    await mkdir(".git");
    await mkdir("packages/app", { recursive: true });
    process.chdir(join(directory, "packages/app"));
    await writeJsonFile("package.json", { scripts: {} });
    await writeJsonFile(CONFIG, { ...controlsRecipe(), integrations: [CONTROLS, "knip"] });
    const result = await derive();
    assert.equal(result.managedFilePlanProblem, null);
    assert.deepEqual(
      result.managedFiles.map(({ path, integration }) => [path, integration]),
      [
        // Only a root-only integration's files move to the repository root; apply's write order
        // puts knip first.
        [KNIP, "knip"],
        ["../../.github/repository-controls.json", CONTROLS],
        ["../../.github/dependabot.yml", CONTROLS],
        ["../../scripts/repository-controls.mjs", CONTROLS],
        ["../../docs/repository-controls.md", CONTROLS],
      ],
    );
  });
});

test("a root-only integration at the repository root, or outside a repository, keeps its paths", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, controlsRecipe());
    const outside = (await derive()).managedFiles.map(({ path }) => path);
    assert.equal(outside[0], ".github/repository-controls.json");
    await mkdir(".git");
    const atRoot = (await derive()).managedFiles.map(({ path }) => path);
    assert.deepEqual(atRoot, outside);
  });
});

test("without running project code, files that need the formatter are not-checked", async () => {
  await inProject(async (directory) => {
    await applied(["editorconfig", "knip"]);
    await declareVitePlus();
    // A formatter that would fail if it ran.
    await writeVitePlusFormatter(directory, { failFor: KNIP });
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    await writeFile(EDITORCONFIG, "root = true\n");
    const result = await deriveProjectPhase({ config: CONFIG, runsProjectCode: false });
    assert.deepEqual(result.formatterFailures, []);
    assert.deepEqual(fileCondition(result, KNIP), {
      name: "not-checked",
      reason: `Calavera did not format what apply writes for ${KNIP}, because this report runs no project code, so it cannot tell whether apply stops on it. Run doctor to check it.`,
    });
    // A file apply writes without the formatter is still compared.
    assert.equal(fileCondition(result, EDITORCONFIG).name, "edited");
    assert.equal(result.phase, "drifted");
  });
});

test("without running project code, a working Vite+ formatter is still never run", async () => {
  await inProject(async (directory) => {
    await applied(["knip"]);
    await declareVitePlus();
    // A formatter that would succeed, so a run would make the edited file edited, not not-checked.
    await writeVitePlusFormatter(directory);
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    assert.equal((await derive()).managedFiles[0]?.condition.name, "edited");
    const result = await deriveProjectPhase({ config: CONFIG, runsProjectCode: false });
    assert.equal(fileCondition(result, KNIP).name, "not-checked");
  });
});

test("without running project code, a project without Vite+ is classified in full", async () => {
  await inProject(async () => {
    // No formatter runs outside a Vite+ project, so nothing needs project code.
    await applied(["knip"]);
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    const result = await deriveProjectPhase({ config: CONFIG, runsProjectCode: false });
    assert.equal(fileCondition(result, KNIP).name, "edited");
    assert.equal(result.phase, "drifted");
  });
});

test("artifact status and the read-only status tool run no project code to find leftover lock entries", async () => {
  await inProject(async (directory) => {
    await applied(["knip"], [ARTIFACT]);
    await declareVitePlus();
    // A vp that leaves a file behind whenever anything runs it.
    const ran = join(directory, "vp-ran");
    await writeVitePlusFormatter(directory, { bin: { vp: "./bin/sentinel.mjs" } });
    await writeFile(
      join(directory, "node_modules/vite-plus/bin/sentinel.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "");\n`,
    );
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    await readArtifactStatus({ config: CONFIG });
    await runArtifactCommand(
      { config: CONFIG, dryRun: false, artifactAction: "status" },
      { ...registry(), loadFormatter: async () => assert.fail("status loads no formatter") },
    );
    await assert.rejects(access(ran), { code: "ENOENT" });
    // The same stand-in runs when the formatter loads, so the check above can fail.
    await derive();
    await access(ran);
  });
});

test("without running project code, a project whose formatter cannot load has no formatter finding", async () => {
  await inProject(async () => {
    await applied(["knip"]);
    await declareVitePlus();
    const result = await deriveProjectPhase({ config: CONFIG, runsProjectCode: false });
    assert.deepEqual(result.formatterFailures, []);
    assert.equal(fileCondition(result, KNIP).name, "current");
  });
});

test("an integration whose required options are missing is a plan problem", async () => {
  await inProject(async () => {
    // Written by hand, as buildRecipe refuses the missing options.
    await writeJsonFile(CONFIG, { ...recipeWith([]), integrations: [CONTROLS] });
    const result = await derive();
    assert.deepEqual(result.managedFiles, []);
    assert.equal(
      result.managedFilePlanProblem,
      `Calavera cannot plan the managed files for the recipe in ${CONFIG}, because apply's check of its integrationOptions refuses them (Error). Run apply --dry-run to see the refusal, fix the recipe, then run the command again.`,
    );
  });
});

test("an integration input Calavera cannot fill in is a plan problem of its own", async () => {
  await inProject(async () => {
    // Outside a Git repository there is no default branch to suggest, so apply cannot fill it in.
    await writeJsonFile(CONFIG, {
      ...recipeWith([]),
      integrations: [CONTROLS],
      integrationOptions: { [CONTROLS]: { repository: "example/phase" } },
    });
    const result = await derive();
    assert.deepEqual(result.managedFiles, []);
    assert.equal(
      result.managedFilePlanProblem,
      `Calavera cannot plan the managed files for the recipe in ${CONFIG}, because it cannot fill in an integration input the way apply does (Error). Run apply --dry-run to see why, record the value in the recipe or fix the cause, then run the command again.`,
    );
  });
});

/** @param {string[]} args */
function git(args) {
  const run = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
}

test("a recorded option that recipe validation trims is planned as apply plans it", async () => {
  await inProject(async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["commit", "--quiet", "--allow-empty", "-m", "start"]);
    await writeJsonFile(CONFIG, {
      ...recipeWith([]),
      integrations: [CONTROLS],
      integrationOptions: { [CONTROLS]: { repository: "example/phase", defaultBranch: " main " } },
    });
    const result = await derive();
    assert.equal(result.managedFilePlanProblem, null);
    assert.equal(fileCondition(result, ".github/repository-controls.json").name, "pending");
  });
});

test("an omitted defaultBranch is planned with the value apply --dry-run uses", async () => {
  await inProject(async () => {
    git(["init", "--quiet", "--initial-branch=trunk"]);
    git(["commit", "--quiet", "--allow-empty", "-m", "start"]);
    const recorded = controlsRecipe();
    const options = recorded.integrationOptions?.[CONTROLS];
    assert.ok(options && typeof options === "object");
    // apply writes only a value the recipe records, so the files are written with trunk recorded.
    const withTrunk = {
      ...recorded,
      integrationOptions: { [CONTROLS]: { ...options, defaultBranch: "trunk" } },
    };
    await writeJsonFile(CONFIG, withTrunk);
    await applyRecipeObject(withTrunk, applyOptions, registry());
    const { defaultBranch, ...withoutBranch } = /** @type {Record<string, unknown>} */ (
      withTrunk.integrationOptions[CONTROLS]
    );
    assert.equal(defaultBranch, "trunk");
    const omitted = { ...withTrunk, integrationOptions: { [CONTROLS]: withoutBranch } };
    await writeJsonFile(CONFIG, omitted);
    const dryRun = await applyRecipeObject(omitted, { ...applyOptions, dryRun: true }, registry());
    assert.equal(
      dryRun.integrationInputs.find(({ name }) => name === "defaultBranch")?.value,
      "trunk",
    );
    // Without the state's records, each file is compared with what apply would write.
    const state = await readJsonFile(STATE);
    state.managedFiles = [];
    await writeJsonFile(STATE, state);
    const result = await derive();
    assert.equal(result.managedFilePlanProblem, null);
    assert.equal(fileCondition(result, ".github/repository-controls.json").name, "current");
  });
});

test("without a recipe, no managed file is classified and no formatter is loaded", async () => {
  await inProject(async () => {
    await applied(["knip"], [ARTIFACT]);
    // A recorded block that is missing would be a wiring finding with a recipe.
    const state = await readJsonFile(STATE);
    state.aiWiring = [
      {
        artifact: ARTIFACT,
        viteHooks: { "pre-commit": "node .agents/skills/project-goal/check.mjs" },
      },
    ];
    await writeJsonFile(STATE, state);
    await rm(CONFIG);
    await declareVitePlus();
    const result = await derive();
    assert.equal(result.phase, "incomplete");
    assert.deepEqual(result.managedFiles, []);
    assert.deepEqual(result.formatterFailures, []);
    assert.deepEqual(result.wiringFindings, []);
    assert.equal(result.managedFilePlanProblem, null);
  });
});

test("a vite-plus package without a vp command is a no-vp-command finding", async () => {
  await inProject(async (directory) => {
    await writeJsonFile(CONFIG, recipeWith(["knip"]));
    await declareVitePlus();
    await writeVitePlusFormatter(directory, { bin: {} });
    assert.deepEqual((await derive()).formatterFailures, [
      {
        path: null,
        kind: "no-vp-command",
        reason:
          "The project's vite-plus package has no vp command, so Calavera cannot format the managed files the way apply does, and apply stops on the same thing. Run vp install, then run the command again.",
      },
    ]);
  });
});

test("an .editorconfig that would change how vp fmt formats a file is an editorconfig-change finding", async () => {
  await inProject(async (directory) => {
    await writeJsonFile(CONFIG, recipeWith(["editorconfig", "knip"]));
    await declareVitePlus();
    await writeVitePlusFormatter(directory);
    // Tabs now; Calavera's .editorconfig sets spaces.
    await writeFile(".editorconfig", "root = true\n\n[*]\nindent_style = tab\n");
    const result = await derive();
    assert.deepEqual(result.formatterFailures, [
      {
        path: KNIP,
        kind: "editorconfig-change",
        reason: `Calavera's .editorconfig would change how vp fmt formats ${KNIP}, so apply stops on the same thing, because Calavera formats every file before it writes any of them. Save the .editorconfig that apply --dry-run prints in the project root, or leave editorconfig out of the recipe, then run the command again.`,
      },
    ]);
    // The reason quotes no setting from the person's file.
    assert.equal(JSON.stringify(result.formatterFailures).includes("tab"), false);
  });
});

test("an invalid integration option is a plan problem, and the phase is still derived", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, { ...recipeWith(["knip"]), integrationOptions: "not an object" });
    const result = await derive();
    assert.equal(result.phase, "composed");
    assert.deepEqual(result.managedFiles, []);
    assert.equal(
      result.managedFilePlanProblem,
      `Calavera cannot plan the managed files for the recipe in ${CONFIG}, because apply's check of its integrationOptions refuses them (TypeError). Run apply --dry-run to see the refusal, fix the recipe, then run the command again.`,
    );
  });
});

test("a recipe whose integrations are not a list of strings stops the function", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, { ...recipeWith([]), integrations: "knip" });
    await assert.rejects(derive(), {
      message: `${CONFIG} integrations must be an array of strings.`,
    });
  });
});

test("a wiring finding about a selected artifact drifts the project; about a deselected one, it does not", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    const state = await readJsonFile(STATE);
    state.aiWiring = [
      {
        artifact: ARTIFACT,
        viteHooks: { "pre-commit": "node .agents/skills/project-goal/check.mjs" },
      },
    ];
    await writeJsonFile(STATE, state);
    let result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(
      result.wiringFindings.map(({ artifact, selected, level }) => [artifact, selected, level]),
      [[ARTIFACT, true, "warning"]],
    );
    assert.match(
      result.wiringFindings[0]?.message ?? "",
      /block that Calavera recorded is missing/,
    );

    await writeJsonFile(CONFIG, recipeWith([]));
    result = await derive();
    assert.equal(result.phase, "applied");
    assert.deepEqual(
      result.wiringFindings.map(({ artifact, selected }) => [artifact, selected]),
      [[ARTIFACT, false]],
    );
  });
});

test("a lock destination that is not normalized still finds its state record", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    const lock = await readJsonFile(LOCK);
    lock.artifacts[0].destination = `./${lock.artifacts[0].destination}`;
    await writeJsonFile(LOCK, lock);
    const result = await derive();
    assert.equal(result.phase, "applied");
    const [artifact] = result.artifacts;
    assert.equal(artifact?.condition.name, "current");
    assert.deepEqual(
      artifact?.outputs.map(({ path }) => path),
      [".agents/skills/project-goal"],
    );
  });
});

test("while a transaction is pending, no managed file, formatter, or wiring is read", async () => {
  await inProject(async () => {
    await applied(["knip"]);
    await declareVitePlus();
    await writeFile(".calavera/artifact-transaction.json", "{ not json");
    const result = await derive();
    assert.equal(result.phase, "pending-transaction");
    assert.deepEqual(result.managedFiles, []);
    assert.deepEqual(result.formatterFailures, []);
    assert.deepEqual(result.wiringFindings, []);
    assert.equal(result.managedFilePlanProblem, null);
  });
});

test("classifying managed files with the formatter writes nothing into the project", async () => {
  await inProject(async (directory) => {
    await applied(["knip", "editorconfig"]);
    await declareVitePlus();
    await writeVitePlusFormatter(directory);
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    const before = await snapshotDirectory();
    const result = await derive();
    assert.deepEqual(await snapshotDirectory(), before);
    assert.equal(fileCondition(result, KNIP).name, "edited");
  });
});

test("the artifact entries keep the shape #1111 reads", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    const [artifact] = (await derive()).artifacts;
    assert.deepEqual(Object.keys(artifact ?? {}).sort(), [
      "condition",
      "id",
      "lockEntry",
      "outputs",
      "selected",
    ]);
    assert.deepEqual(Object.keys(artifact?.condition ?? {}).sort(), ["name", "reason"]);
  });
});
