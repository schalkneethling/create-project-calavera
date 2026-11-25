// Issue #1148: every other doctor test spawns the CLI, and Stryker cannot trace a child process, so
// doctor's mutants showed as not covered. These tests call doctor in this process, from the
// project directory, and pin the exact result each branch returns. The spawned tests still prove
// the CLI's output and exit code.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { legacyEntryWiringRefusal } from "../src/ai/recipe-items.js";
import { planViteHookBlock } from "../src/ai/vite-hook-blocks.js";
import {
  doctor,
  removedProfileWarnings,
  removedToolchainWarnings,
  unknownIntegrationWarnings,
} from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { detectVitePlus } from "../src/vite-plus-detection.js";
import { createTemporaryFixture, json } from "./vite-plus-fixtures.mjs";

const RECIPE = "calavera.config.json";
const STATE = ".calavera/state.json";
const guardId = "skill-protected-branch-guard";
const guardHookLine =
  "node .agents/skills/protected-branch-guard/scripts/guard.mjs pre-commit main";
const missingPackageJSON = {
  level: "warning",
  message:
    "Missing package.json. apply creates one; when a manifest above this directory exists, apply asks whether to create one here, apply there, or stop.",
};

/**
 * The findings of a doctor result, without the phase line that comes first and without each
 * issue's check, so a test pins the findings it is about (ADR-0020, Decision 4). The phase line's
 * own rules are pinned in doctor-phase.test.mjs.
 *
 * @param {import("../src/index.js").DoctorResult} result
 */
function findings(result) {
  return result.issues
    .filter(({ check }) => check !== "phase")
    .map(({ level, message }) => ({ level, message }));
}

/**
 * Runs doctor in `directory` and restores the previous working directory afterward.
 *
 * @param {string} directory
 * @param {Partial<import("../src/index.js").CliOptions>} [options]
 */
async function doctorIn(directory, options = {}) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await doctor({ config: RECIPE, ...options });
  } finally {
    process.chdir(previous);
  }
}

/** @param {object} recipe */
function recipeFile(recipe) {
  return json({ version: 1, ...recipe });
}

// ADR-0020, owner decision 2: a project without Calavera's files is `unmanaged`, an error in both
// doctors, which replaces the earlier "Missing calavera.config.json" error.
const unmanagedLine =
  "No recipe, state, or lock exists here, so Calavera does not manage this project. Pass --config <path> when the recipe is saved elsewhere, or run npm create project-calavera init to start.";

test("Given no recipe, doctor reports the unmanaged phase as an error and does not read further", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-no-recipe", {
    "package.json": json({ name: "fixture" }),
  });

  const result = await doctorIn(fixture.root);
  assert.equal(result.ok, false);
  assert.equal(result.phase, "unmanaged");
  assert.deepEqual(result.issues, [{ level: "error", check: "phase", message: unmanagedLine }]);
});

test("Given neither a recipe nor package.json, doctor reports both, the phase line first", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-empty", {
    ".keep": "",
  });

  const result = await doctorIn(fixture.root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, [
    { level: "error", check: "phase", message: unmanagedLine },
    { ...missingPackageJSON, check: "project" },
  ]);
});

test("doctor reads the recipe from options.config", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-config-path", {
    "package.json": json({ name: "fixture" }),
    "config/recipe.json": recipeFile({ profile: "default", integrations: [] }),
  });

  const result = await doctorIn(fixture.root, { config: "config/recipe.json" });
  assert.equal(result.ok, true);
  assert.equal(result.phase, "composed");
  // The phase line names the recipe path doctor read.
  assert.match(
    result.phaseLine?.message ?? "",
    /^The recipe in config\/recipe\.json is not applied yet/,
  );
  assert.deepEqual(findings(result), []);
});

test("Given a recipe and no package.json, doctor warns and stays ok", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-no-manifest", {
    [RECIPE]: recipeFile({ profile: "default", integrations: [] }),
  });

  const result = await doctorIn(fixture.root);
  assert.equal(result.ok, true);
  assert.deepEqual(findings(result), [missingPackageJSON]);
});

test("Given a recipe that is not valid JSON, doctor stops with an error after the issues found before it", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-invalid-recipe", {
    [RECIPE]: '{\n  "version": 1,\n',
  });

  const result = await doctorIn(fixture.root);

  assert.equal(result.command, "doctor");
  assert.equal(result.ok, false);
  // ADR-0020 Amendment 1: a run that stops before it classifies has no phase.
  assert.equal(Object.hasOwn(result, "phase"), false);
  assert.equal(result.issues.length, 2, JSON.stringify(result.issues));
  assert.deepEqual(result.issues[0], { ...missingPackageJSON, check: "project" });
  assert.equal(result.issues[1]?.level, "error");
  assert.equal(result.issues[1]?.check, "records");
  assert.match(result.issues[1]?.message ?? "", /calavera\.config\.json/);
});

test("doctor lists the removed profile, removed toolchain, and unknown integration warnings in apply's order", async () => {
  const recipe = { profile: "modern", integrations: ["oxlint", "not-an-integration"] };
  await using fixture = await createTemporaryFixture("doctor-in-process-recipe-warnings", {
    "package.json": json({ name: "fixture", devDependencies: { "vite-plus": "1.0.0" } }),
    [RECIPE]: recipeFile(recipe),
  });
  const detection = await detectVitePlus(fixture.root);
  assert.equal(detection.status, "managed", "the fixture must be a Vite+ project");
  const parsed = /** @type {import("../src/index.js").Recipe} */ ({ version: 1, ...recipe });
  const expected = [
    ...removedProfileWarnings(parsed, RECIPE),
    ...removedToolchainWarnings(parsed, detection, RECIPE),
    ...unknownIntegrationWarnings(parsed, detection, RECIPE),
  ];
  // Each helper contributes, so dropping any one of them from doctor changes the result.
  assert.equal(expected.length, 3, JSON.stringify(expected));

  const result = await doctorIn(fixture.root);
  assert.deepEqual(
    result.issues
      .filter(({ check }) => check === "recipe")
      .map(({ level, message }) => ({ level, message })),
    expected,
  );
  // The fixture declares vite-plus without installing it, so the formatter apply would load
  // cannot load, an error on the managed-file check (ADR-0020, owner decision 17).
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.issues.filter(({ level }) => level === "error").map(({ check }) => check),
    ["managed-file-check"],
  );
});

test("Given a legacy entry that selects a wired artifact, doctor reports apply's refusal as an error", async () => {
  const ai = [{ type: "skill", src: "skills/protected-branch-guard" }];
  await using fixture = await createTemporaryFixture("doctor-in-process-legacy-refusal", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({ profile: "default", integrations: [], ai }),
  });
  const refusal = legacyEntryWiringRefusal(ai, "apply stops before writing anything");
  assert.ok(refusal !== undefined);

  const result = await doctorIn(fixture.root);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.issues.filter(({ level }) => level === "error"),
    [{ level: "error", message: refusal, check: "recipe" }],
  );
});

test("Given a selected integration whose managed file does not exist yet, doctor warns and names the file", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-missing-file", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({ profile: "default", integrations: ["editorconfig"] }),
  });

  const result = await doctorIn(fixture.root);
  assert.equal(result.ok, true);
  // ADR-0020, Decision 4: a file apply has not written yet is pending, a warning with the apply
  // command, which replaces the earlier "Missing managed file" warning.
  assert.deepEqual(result.issues.slice(1), [
    {
      level: "warning",
      check: "managed-file",
      message:
        ".editorconfig does not exist yet, so apply writes it. Run npm create project-calavera apply.",
    },
  ]);

  // The person's own file there is a note: apply stops on it as not recorded.
  await writeFile(join(fixture.root, ".editorconfig"), "root = true\n");
  assert.deepEqual(
    (await doctorIn(fixture.root)).issues.slice(1).map(({ level, check }) => [level, check]),
    [["info", "managed-file"]],
  );
});

test("Given Varlock without its schema, doctor warns until the schema exists", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-varlock", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({ profile: "default", integrations: ["varlock"] }),
  });
  const schemaWarning = {
    level: "warning",
    message:
      "Missing Varlock schema: .env.schema. Run create-project-calavera apply to scaffold it.",
    check: "managed-file",
  };

  assert.deepEqual(
    (await doctorIn(fixture.root)).issues.filter(({ message }) => message.includes("Varlock")),
    [schemaWarning],
  );

  await writeFile(join(fixture.root, ".env.schema"), "# @defaultRequired=false\n");
  assert.deepEqual(
    (await doctorIn(fixture.root)).issues.filter(({ message }) => message.includes("Varlock")),
    [],
  );
});

test("Given a selected AI artifact that is not installed, doctor reports it as pending in a note", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-ai-output", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ id: "skill-project-goal" }],
    }),
  });

  // ADR-0020, Decision 4 and #994: a selection that is not installed yet is a note, as artifacts
  // doctor gives it, which replaces the earlier "Missing managed AI skill" warning.
  const result = await doctorIn(fixture.root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues.slice(1), [
    {
      level: "info",
      check: "artifact",
      message:
        "The recipe selects skill-project-goal, which has no lock entry yet, so artifacts install or apply installs it.",
    },
  ]);
  assert.deepEqual(
    result.artifacts?.map(({ id, condition }) => [id, condition.name]),
    [["skill-project-goal", "pending"]],
  );
});

// A workspace member under a `.git` repository root, each with its own package.json.
const memberFiles = {
  ".git/HEAD": "ref: refs/heads/main\n",
  "package.json": json({ name: "root", private: true }),
  "packages/member/package.json": json({ name: "member" }),
};
const repositoryControls = {
  "github-repository-controls": { repository: "octocat/example", defaultBranch: "main" },
};

test("From a workspace member, doctor reports apply's root-only refusal and checks the root-only files at the repository root", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-member-root-only", {
    ...memberFiles,
    [`packages/member/${RECIPE}`]: recipeFile({
      ...buildRecipe(
        "minimal",
        ["editorconfig", "github-repository-controls"],
        "pnpm",
        [],
        repositoryControls,
      ),
    }),
  });
  const member = join(fixture.root, "packages/member");

  const { ok, issues } = await doctorIn(member);

  assert.equal(ok, false);
  const errors = issues.filter(({ level }) => level === "error");
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(
    errors[0]?.message ?? "",
    /github-repository-controls applies at the repository root/,
  );
  assert.equal(errors[0]?.check, "repository-root");
  // The refusal names the recipe's package manager, which doctor resolves only from a member.
  assert.match(errors[0]?.message ?? "", /pnpm dlx create-project-calavera apply --dry-run/);
  // editorconfig is not root-only, so doctor checks its file in the member; the root-only files
  // are checked at the repository root, and their remedy runs apply from there.
  const managed = issues.filter(({ check }) => check === "managed-file");
  const [editorconfig, ...rootOnlyWarnings] = managed;
  assert.deepEqual(editorconfig, {
    level: "warning",
    check: "managed-file",
    message:
      ".editorconfig does not exist yet, so apply writes it. Run pnpm dlx create-project-calavera apply.",
  });
  assert.ok(rootOnlyWarnings.length > 0, "doctor checked no root-only file");
  for (const { level, message } of rootOnlyWarnings) {
    assert.equal(level, "warning");
    assert.match(
      message,
      /^\.\.\/\.\.\/\S+ does not exist yet, so apply writes it\. Run pnpm dlx create-project-calavera apply from the repository root\.$/,
    );
  }
});

test("At the repository root, doctor reports no root-only refusal, names the files from there, and does not resolve the package manager", async () => {
  // resolveApplyPackageManager refuses "deno", so doctor would report an error if it resolved it.
  await using fixture = await createTemporaryFixture("doctor-in-process-root", {
    ...memberFiles,
    [RECIPE]: recipeFile({
      ...buildRecipe("minimal", ["github-repository-controls"], "pnpm", [], repositoryControls),
      packageManager: "deno",
    }),
  });

  const { ok, issues } = await doctorIn(fixture.root);

  assert.equal(ok, true, JSON.stringify(issues));
  const managed = issues.filter(({ check }) => check === "managed-file");
  assert.ok(managed.length > 0, "doctor checked no file");
  assert.deepEqual(
    issues.filter(({ check }) => check === "repository-root"),
    [],
  );
  for (const { level, message } of managed) {
    assert.equal(level, "warning");
    assert.match(message, /^(?!\.\.\/)\S+ does not exist yet, so apply writes it\. Run /);
  }
});

test("From a workspace member, doctor reports apply's Git-hook refusal for an artifact that writes Git hooks", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-member-git-hook", {
    ...memberFiles,
    [`packages/member/${RECIPE}`]: recipeFile({
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ id: guardId }],
    }),
  });

  const { ok, issues } = await doctorIn(join(fixture.root, "packages/member"));

  assert.equal(ok, false);
  const errors = issues.filter(({ level }) => level === "error");
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0]?.message ?? "", new RegExp(guardId));
  assert.match(errors[0]?.message ?? "", /npm create project-calavera apply -- --dry-run/);
});

test("From a workspace member with neither a root-only integration nor a Git-hook artifact, doctor does not resolve the package manager", async () => {
  // resolveApplyPackageManager refuses "deno", so doctor would report an error if it resolved it.
  await using fixture = await createTemporaryFixture("doctor-in-process-member-plain", {
    ...memberFiles,
    [`packages/member/${RECIPE}`]: recipeFile({
      profile: "default",
      integrations: [],
      packageManager: "deno",
    }),
  });

  const result = await doctorIn(join(fixture.root, "packages/member"));
  assert.equal(result.ok, true);
  assert.deepEqual(findings(result), []);
});

test("Given recorded wiring whose hook file is missing, doctor's finding follows whether the recipe still selects the artifact", async () => {
  const state = json({
    version: 1,
    aiWiring: [{ artifact: guardId, viteHooks: { "pre-commit": guardHookLine } }],
  });
  await using fixture = await createTemporaryFixture("doctor-in-process-wiring", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({ profile: "default", integrations: [] }),
    [STATE]: state,
  });
  const wiringMessages = async () =>
    (await doctorIn(fixture.root)).issues
      .map(({ message }) => message)
      .filter((message) => message.startsWith(".vite-hooks/pre-commit"));

  const [deselected, ...restDeselected] = await wiringMessages();
  assert.deepEqual(restDeselected, []);
  assert.match(deselected ?? "", new RegExp(`the recipe no longer selects ${guardId}`));

  await writeFile(
    join(fixture.root, RECIPE),
    recipeFile({ profile: "default", integrations: [], ai: [{ id: guardId }] }),
  );
  assert.ok(
    (await doctorIn(fixture.root)).issues
      .filter(({ message }) => message.startsWith(".vite-hooks/pre-commit"))
      .every(({ check }) => check === "wiring"),
  );
  const [selected, ...restSelected] = await wiringMessages();
  assert.deepEqual(restSelected, []);
  assert.doesNotMatch(selected ?? "", /no longer selects/);
});

test("Given an intact recorded block whose script is missing, doctor names the script in the skill's installed directory", async () => {
  const hook = planViteHookBlock({
    path: ".vite-hooks/pre-commit",
    contents: undefined,
    artifactId: guardId,
    line: guardHookLine,
    recorded: undefined,
  });
  await using fixture = await createTemporaryFixture("doctor-in-process-wiring-script", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({ profile: "default", integrations: [] }),
    [STATE]: json({
      version: 1,
      aiWiring: [{ artifact: guardId, viteHooks: { "pre-commit": guardHookLine } }],
    }),
    ".vite-hooks/pre-commit": hook.contents ?? "",
  });

  const errors = (await doctorIn(fixture.root)).issues.filter(({ level }) => level === "error");

  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(
    errors[0]?.message ?? "",
    /^\.vite-hooks\/pre-commit: the skill-protected-branch-guard block runs \.agents\/skills\/protected-branch-guard\/scripts\/guard\.mjs, which does not exist/,
  );
});

test("Given a state file that is a directory, doctor stops with an error that names the state file", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-state-error", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({ profile: "default", integrations: [] }),
  });
  await mkdir(join(fixture.root, STATE), { recursive: true });

  const result = await doctorIn(fixture.root);

  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(result, "phase"), false);
  assert.equal(result.issues.length, 1, JSON.stringify(result.issues));
  assert.equal(result.issues[0]?.level, "error");
  assert.equal(result.issues[0]?.check, "records");
  assert.match(result.issues[0]?.message ?? "", /^doctor cannot use \.calavera\/state\.json\./);
  assert.match(result.issues[0]?.message ?? "", /EISDIR/);
});

test("A run that stops on the state keeps the recipe warnings it found before the stop", async () => {
  await using fixture = await createTemporaryFixture("doctor-in-process-stop-after-warning", {
    "package.json": json({ name: "fixture" }),
    [RECIPE]: recipeFile({ profile: "modern", integrations: [] }),
  });
  await mkdir(join(fixture.root, STATE), { recursive: true });

  const result = await doctorIn(fixture.root);
  assert.deepEqual(
    result.issues.map(({ level, check }) => [level, check]),
    [
      ["warning", "recipe"],
      ["error", "records"],
    ],
  );
});
