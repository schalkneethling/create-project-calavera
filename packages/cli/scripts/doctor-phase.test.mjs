// #1112 (ADR-0020, Decisions 4, 5, and 8): `doctor` reads the project phase from
// `deriveProjectPhase`. Its result gains `phase`, `phaseLine`, `artifacts`, and `managedFiles`,
// each issue gains `check`, and `level` gains `info`. It reports each managed file's condition,
// each artifact's condition at the levels #994 set, and agrees with `artifacts doctor` about every
// artifact and about the phase (owner decision 10).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtempDisposable, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { isArtifactHealthy } from "../src/artifact-status-report.js";
import { applyRecipeObject, doctor } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { listingViolations } from "../../../scripts/rehearsal-checks.mjs";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const CONFIG = "calavera.config.json";
const STATE = ".calavera/state.json";
const LOCK = ".calavera/artifacts.lock.json";
const JOURNAL = ".calavera/artifact-transaction.json";
const ARTIFACT = "skill-project-goal";
const SKILL = ".agents/skills/project-goal";
const OTHER = "skill-code-review";
const OTHER_SKILL = ".agents/skills/code-review";
const KNIP = "knip.json";
const EDITORCONFIG = ".editorconfig";
const applyOptions = { json: true, noInstall: true, assumeYes: true };
const registry = () =>
  stubRegistry(
    new Map([
      [ARTIFACT, "0.1.0"],
      [OTHER, "0.2.0"],
    ]),
  );

/** @param {(directory: string) => Promise<void>} callback */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-doctor-phase-"));
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

/** @param {string} path @param {unknown} value */
async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} path */
async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {string[]} integrations @param {string[]} ai */
const recipeWith = (integrations, ai) => ({
  ...buildRecipe("minimal", integrations, "npm"),
  ai: ai.map((id) => ({ id })),
});

/** @param {string[]} integrations @param {string[]} ai */
async function applied(integrations, ai) {
  await writeJsonFile(CONFIG, recipeWith(integrations, ai));
  await applyRecipeObject(recipeWith(integrations, ai), applyOptions, registry());
}

const runDoctor = () => doctor({ config: CONFIG });
const runArtifactsDoctor = () =>
  runArtifactCommand({ config: CONFIG, dryRun: false, artifactAction: "doctor" }, registry());

/**
 * @param {Awaited<ReturnType<typeof runDoctor>>} result
 * @param {string} check
 */
const issuesOf = (result, check) =>
  result.issues
    .filter((issue) => issue.check === check)
    .map(({ level, message }) => ({ level, message }));

/** @param {string} cwd @param {string[]} args */
function runCli(cwd, args) {
  return /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */ (
    new Promise((resolve) => {
      execFile(process.execPath, [cli, ...args], { cwd }, (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
        }),
      );
    })
  );
}

/**
 * The level each doctor gives an artifact: doctor's issue level for it, and the level artifacts
 * doctor gives it, from whether it fails the verdict and whether its line is a warning.
 *
 * @param {Awaited<ReturnType<typeof runDoctor>>} doctorResult
 * @param {Awaited<ReturnType<typeof runArtifactsDoctor>>} artifactsResult
 */
function artifactLevels(doctorResult, artifactsResult) {
  return artifactsResult.artifacts.map((artifact) => {
    const doctorIssue = doctorResult.issues.find(
      ({ check, message }) => check === "artifact" && message.includes(artifact.condition.reason),
    );
    const problem = ["missing", "unreadable", "edited", "unrecorded"].includes(
      artifact.condition.name,
    );
    const artifactsLevel = !isArtifactHealthy(artifact)
      ? "error"
      : artifact.selected === false && problem
        ? "warning"
        : "other";
    const doctorLevel =
      doctorIssue?.level === "error" || doctorIssue?.level === "warning"
        ? doctorIssue.level
        : "other";
    return { id: artifact.id, doctorLevel, artifactsLevel };
  });
}

/**
 * Owner decision 10: the two doctors give each artifact the same condition and level, and the
 * same phase at the same level.
 */
async function assertAgreement() {
  const doctorResult = await runDoctor();
  const artifactsResult = await runArtifactsDoctor();
  assert.equal(doctorResult.phase, artifactsResult.phase);
  // doctor calls its levels error, warning, and info; the artifact report error, warn, and info.
  const artifactsLevel =
    artifactsResult.phaseLine.level === "warn" ? "warning" : artifactsResult.phaseLine.level;
  assert.equal(doctorResult.phaseLine?.level, artifactsLevel);
  assert.deepEqual(
    doctorResult.artifacts?.map(({ id, condition }) => ({ id, condition })),
    artifactsResult.artifacts.map(({ id, condition }) => ({ id, condition })),
  );
  for (const { id, doctorLevel, artifactsLevel } of artifactLevels(doctorResult, artifactsResult)) {
    assert.equal(doctorLevel, artifactsLevel, id);
  }
  return { doctorResult, artifactsResult };
}

test("doctor reports the phase line as its first issue, at the doctors' level, with a check", async () => {
  await inProject(async () => {
    let result = await runDoctor();
    assert.equal(result.phase, "unmanaged");
    assert.equal(result.phaseLine?.level, "error");
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues[0], {
      level: "error",
      check: "phase",
      message: result.phaseLine?.message,
    });

    await writeJsonFile(CONFIG, recipeWith([], [ARTIFACT]));
    result = await runDoctor();
    assert.equal(result.phase, "composed");
    assert.equal(result.issues[0]?.level, "warning");
    assert.equal(result.ok, true);

    await applied([], [ARTIFACT]);
    result = await runDoctor();
    assert.equal(result.phase, "applied");
    assert.equal(result.issues[0]?.level, "info");
    assert.equal(result.ok, true);
  });
});

test("a bootstrapped project passes doctor with a warning, and an incomplete one fails it", async () => {
  await inProject(async (directory) => {
    const { code } = await runCli(directory, ["--init", "--yes", "--mcp-harness", "skip"]);
    assert.equal(code, 0);
    let result = await runDoctor();
    assert.equal(result.phase, "bootstrapped");
    assert.equal(result.ok, true);
    assert.equal(result.issues[0]?.level, "warning");

    await applied([], [ARTIFACT]);
    await rm(CONFIG);
    result = await runDoctor();
    assert.equal(result.phase, "incomplete");
    assert.equal(result.ok, false);
  });
});

test("doctor reports each managed file's condition at its level", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, recipeWith(["editorconfig", "knip"], []));
    // Pending: a warning with the apply command.
    let result = await runDoctor();
    assert.deepEqual(
      issuesOf(result, "managed-file").map(({ level }) => level),
      ["warning", "warning"],
    );
    assert.match(
      issuesOf(result, "managed-file")[0]?.message ?? "",
      /npm create project-calavera apply/,
    );

    await applied(["editorconfig", "knip"], []);
    assert.deepEqual(issuesOf(await runDoctor(), "managed-file"), []);

    // Missing after apply: an error.
    await rm(EDITORCONFIG);
    result = await runDoctor();
    assert.deepEqual(
      issuesOf(result, "managed-file").map(({ level }) => level),
      ["error"],
    );
    assert.equal(result.ok, false);
    await applyRecipeObject(recipeWith(["editorconfig", "knip"], []), applyOptions, registry());

    // Edited so that apply stops on it: a note that offers the ways to keep the edit first.
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    result = await runDoctor();
    const [edited] = issuesOf(result, "managed-file");
    assert.equal(edited?.level, "info");
    assert.equal(result.ok, true);
    assert.ok(
      (edited?.message ?? "").indexOf("save a copy") <
        (edited?.message ?? "").indexOf("--reown-managed-file"),
      edited?.message,
    );

    // Unreadable: an error (owner decision of 2026-11-25).
    await rm(KNIP);
    await mkdir(KNIP);
    result = await runDoctor();
    assert.deepEqual(
      issuesOf(result, "managed-file").map(({ level }) => level),
      ["error"],
    );
  });
});

test("a person's file at a managed path is a note whose remedies keep the file, never --reown-managed-file", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, recipeWith(["knip"], []));
    await writeJsonFile(KNIP, { entry: ["src/main.ts"] });
    const result = await runDoctor();
    const [note] = issuesOf(result, "managed-file");
    assert.equal(note?.level, "info");
    assert.match(note?.message ?? "", /rename or move it/);
    assert.equal((note?.message ?? "").includes("--reown-managed-file"), false);
    assert.equal(result.ok, true);
  });
});

test("a formatter failure and a plan problem are errors on the managed-file check, and the phase is still classified", async () => {
  await inProject(async () => {
    await applied(["knip"], []);
    await writeJsonFile("package.json", { scripts: {}, devDependencies: { "vite-plus": "1.0.0" } });
    let result = await runDoctor();
    assert.equal(result.phase, "applied");
    assert.deepEqual(
      issuesOf(result, "managed-file-check").map(({ level }) => level),
      ["error"],
    );
    assert.equal(result.ok, false);

    await writeJsonFile("package.json", { scripts: {} });
    await writeJsonFile(CONFIG, {
      ...recipeWith(["knip"], []),
      integrationOptions: "not an object",
    });
    result = await runDoctor();
    assert.match(
      issuesOf(result, "managed-file-check")[0]?.message ?? "",
      /cannot plan the managed files/,
    );
    assert.equal(result.ok, false);
  });
});

test("doctor reports each artifact's condition at the levels #994 set, and agrees with artifacts doctor", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, recipeWith([], [ARTIFACT]));
    // Pending before apply: a note.
    let { doctorResult } = await assertAgreement();
    assert.deepEqual(
      issuesOf(doctorResult, "artifact").map(({ level }) => level),
      ["info"],
    );

    await applied([], [ARTIFACT, OTHER]);
    ({ doctorResult } = await assertAgreement());
    assert.deepEqual(issuesOf(doctorResult, "artifact"), []);

    // Selected and edited, missing, or unrecorded: an error.
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    ({ doctorResult } = await assertAgreement());
    assert.deepEqual(
      issuesOf(doctorResult, "artifact").map(({ level }) => level),
      ["error"],
    );
    assert.equal(doctorResult.phase, "drifted");
    await rm(SKILL, { recursive: true });
    ({ doctorResult } = await assertAgreement());
    assert.deepEqual(
      issuesOf(doctorResult, "artifact").map(({ level }) => level),
      ["error"],
    );

    // Deselected with deleted or edited files: a warning (#1111, owner decision 6).
    await writeJsonFile(CONFIG, recipeWith([], [ARTIFACT]));
    await writeFile(join(OTHER_SKILL, "SKILL.md"), "edited\n");
    ({ doctorResult } = await assertAgreement());
    assert.ok(
      issuesOf(doctorResult, "artifact").some(
        ({ level, message }) => level === "warning" && message.includes(OTHER),
      ),
    );
  });
});

test("doctor's result lists every classified artifact and managed file with its condition", async () => {
  await inProject(async () => {
    await applied(["knip"], [ARTIFACT]);
    const result = await runDoctor();
    assert.deepEqual(
      result.artifacts?.map(({ id, selected, condition }) => [id, selected, condition.name]),
      [[ARTIFACT, true, "current"]],
    );
    assert.deepEqual(
      result.managedFiles?.map(({ path, selected, condition }) => [path, selected, condition.name]),
      [[KNIP, true, "current"]],
    );
  });
});

test("during a pending transaction doctor reports the phase error, the rollback's files, and the recipe checks only", async () => {
  await inProject(async () => {
    await applied(["knip"], [ARTIFACT]);
    await writeJsonFile(CONFIG, { ...recipeWith(["knip"], [ARTIFACT]), profile: "modern" });
    const root = ".calavera/.transactions/stopped";
    await mkdir(`${root}/backup`, { recursive: true });
    await writeJsonFile(JOURNAL, {
      schemaVersion: 1,
      transactionRoot: root,
      operations: [
        {
          staged: `${root}/staged/x`,
          target: ".agents/skills/x",
          backup: `${root}/backup/x`,
          hadTarget: false,
        },
      ],
    });
    // A state that would stop the run if it were read.
    await writeFile(STATE, "{ not json");
    const before = await snapshotDirectory();
    const result = await runDoctor();
    assert.deepEqual(await snapshotDirectory(), before);
    assert.equal(result.phase, "pending-transaction");
    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.check, "phase");
    assert.match(result.issues[0]?.message ?? "", /artifacts status/);
    assert.match(
      result.issues[0]?.message ?? "",
      /so this doctor does not read the artifact records/,
    );
    assert.deepEqual(result.rollbackFiles, [".agents/skills/x"]);
    assert.ok(issuesOf(result, "recipe").length > 0, "the recipe checks still run");
    for (const check of ["managed-file", "artifact", "wiring"]) {
      assert.deepEqual(issuesOf(result, check), [], check);
    }
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.managedFiles, []);
  });
});

/** A journal for a transaction that stopped before its rollback ran. */
async function writePendingJournal() {
  const root = ".calavera/.transactions/stopped";
  await mkdir(`${root}/backup`, { recursive: true });
  await writeJsonFile(JOURNAL, {
    schemaVersion: 1,
    transactionRoot: root,
    operations: [
      {
        staged: `${root}/staged/x`,
        target: ".agents/skills/x",
        backup: `${root}/backup/x`,
        hadTarget: false,
      },
    ],
  });
}

// ADR-0020, Decisions 1 and 5: a pending transaction wins over every other finding, including an
// unreadable record, so a recipe doctor cannot use is a finding then, not a stop, and both doctors
// report the phase pending-transaction.
for (const { label, expected, setup } of [
  {
    label: "a recipe that cannot be parsed",
    expected: /calavera\.config\.json cannot be parsed as JSON/,
    setup: async () => writeFile(CONFIG, "{ not json"),
  },
  {
    label: "a recipe whose artifact source no catalog provides",
    expected: /names a legacy src that Calavera does not know/,
    setup: async () =>
      writeJsonFile(CONFIG, {
        ...recipeWith([], []),
        ai: [{ type: "skill", src: "skills/not-in-any-catalog" }],
      }),
  },
  {
    label: "a workspace member's recipe with a package manager Calavera does not support",
    expected: /deno/,
    setup: async (/** @type {string} */ directory) => {
      await mkdir(".git");
      await mkdir("packages/app/.calavera", { recursive: true });
      process.chdir(join(directory, "packages/app"));
      await writeJsonFile("package.json", { name: "app" });
      await writeJsonFile(CONFIG, {
        ...buildRecipe("minimal", ["github-repository-controls"], "npm", [], {
          "github-repository-controls": { repository: "example/phase", defaultBranch: "main" },
        }),
        packageManager: "deno",
      });
    },
  },
]) {
  test(`with a pending transaction, ${label} is a finding, and both doctors report the phase`, async () => {
    await inProject(async (directory) => {
      await setup(directory);
      await writePendingJournal();
      const before = await snapshotDirectory();

      const result = await runDoctor();
      const artifacts = /** @type {{ phase: string }} */ (await runArtifactsDoctor());

      assert.deepEqual(await snapshotDirectory(), before);
      assert.equal(result.phase, "pending-transaction", JSON.stringify(result.issues));
      assert.equal(artifacts.phase, result.phase);
      assert.equal(result.ok, false);
      assert.equal(result.issues[0]?.check, "phase");
      const recipe = issuesOf(result, "recipe").filter(({ level }) => level === "error");
      assert.equal(recipe.length, 1, JSON.stringify(result.issues));
      assert.match(recipe[0]?.message ?? "", expected);
      assert.deepEqual(issuesOf(result, "records"), []);
    });
  });
}

test("with only a managed file drifted, doctor's phase line is the bare drifted line, which points nowhere else", async () => {
  await inProject(async () => {
    await applied(["editorconfig"], []);
    await rm(EDITORCONFIG);

    const result = await runDoctor();
    const artifacts = /** @type {{ phaseLine: { message: string } }} */ (
      await runArtifactsDoctor()
    );

    assert.equal(result.phase, "drifted");
    // doctor lists the file itself, under "Managed files:", so its line does not send the person
    // to doctor, as the artifact commands' line does.
    assert.equal(result.phaseLine?.message, "The phase is drifted.");
    assert.notEqual(artifacts.phaseLine.message, "The phase is drifted.");
    assert.match(artifacts.phaseLine.message, /\.editorconfig/);
    assert.deepEqual(
      issuesOf(result, "managed-file").map(({ level }) => level),
      ["error"],
    );
  });
});

test("doctor names a changed hook marker line without printing it back", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    const recorded = "node .agents/skills/project-goal/check.mjs";
    const state = await readJsonFile(STATE);
    state.aiWiring = [{ artifact: ARTIFACT, viteHooks: { "pre-commit": recorded } }];
    await writeJsonFile(STATE, state);
    await mkdir(".vite-hooks");
    // A token the person appended to the start marker, which findBlock's own reason quotes.
    await writeFile(
      ".vite-hooks/pre-commit",
      `# calavera:${ARTIFACT}:start person-text\n${recorded}\n# calavera:${ARTIFACT}:end\n`,
    );

    const [finding] = (await runDoctor()).issues.filter(({ check }) => check === "wiring");

    assert.deepEqual(finding, {
      level: "warning",
      check: "wiring",
      artifact: ARTIFACT,
      message: `.vite-hooks/pre-commit: a marker line of the ${ARTIFACT} block was changed, so apply stops on it. Calavera only recognizes "# calavera:${ARTIFACT}:start" and "# calavera:${ARTIFACT}:end" as whole lines. Restore them, or remove the block, both markers included, and run create-project-calavera apply again.`,
      detail: `.vite-hooks/pre-commit: a marker line of the block was changed, so apply stops on it. Calavera only recognizes "# calavera:${ARTIFACT}:start" and "# calavera:${ARTIFACT}:end" as whole lines. Restore them, or remove the block, both markers included, and run create-project-calavera apply again.`,
    });
  });
});

test("a record the phase cannot read stops doctor with a result that has no phase", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await writeJsonFile(LOCK, { schemaVersion: 1 });
    const result = await runDoctor();
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "phase"), false);
    assert.deepEqual(result.issues.at(-1), {
      level: "error",
      check: "records",
      message: "Invalid artifact lockfile.",
    });
  });
});

test("an unparsable package.json in a workspace member is a finding, and doctor still classifies", async () => {
  await inProject(async (directory) => {
    await mkdir(".git");
    await mkdir("packages/app", { recursive: true });
    process.chdir(join(directory, "packages/app"));
    await writeFile("package.json", "{ not json");
    await writeJsonFile(
      CONFIG,
      buildRecipe("minimal", ["github-repository-controls"], "npm", [], {
        "github-repository-controls": { repository: "example/phase", defaultBranch: "main" },
      }),
    );
    const result = await runDoctor();
    assert.equal(result.phase, "composed");
    const [finding] = issuesOf(result, "repository-root");
    assert.equal(finding?.level, "error");
    assert.match(finding?.message ?? "", /package\.json cannot be parsed as JSON/);
  });
});

test("doctor's text output starts with the phase line, groups items under headings, and names each once", async () => {
  await inProject(async (directory) => {
    await applied(["editorconfig", "knip"], [ARTIFACT, OTHER]);
    await writeJsonFile(CONFIG, recipeWith(["editorconfig", "knip"], [ARTIFACT]));
    await rm(EDITORCONFIG);
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    await rm(OTHER_SKILL, { recursive: true });
    const { code, stdout, stderr } = await runCli(directory, ["doctor"]);
    assert.equal(code, 1, stdout + stderr);
    const output = `${stdout}${stderr}`;
    assert.equal(stdout.split("\n")[0], "The phase is drifted.");
    for (const heading of ["Managed files:", "Artifacts:"]) {
      assert.ok(output.split("\n").includes(heading), `${heading}\n${output}`);
    }
    assert.deepEqual(listingViolations(output, [EDITORCONFIG, ARTIFACT, OTHER]), []);
    // The verdict names the checks artifacts doctor does not make.
    assert.equal(
      stderr.trimEnd().split("\n").at(-1),
      "Calavera doctor found 2 errors: a managed file's condition and an artifact's condition. artifacts doctor does not report a managed file's condition.",
    );
  });
});

test("the listing check passes on doctor's output in composed, incomplete, and pending-transaction projects", async () => {
  await inProject(async (directory) => {
    // Composed: the pending managed files and artifact are listed under their headings, once.
    await writeJsonFile(CONFIG, recipeWith(["editorconfig", "knip"], [ARTIFACT]));
    let { stdout, stderr } = await runCli(directory, ["doctor"]);
    let output = `${stdout}${stderr}`;
    assert.equal(
      stderr.split("\n")[0],
      "The recipe in calavera.config.json is not applied yet, so run npm create project-calavera apply.",
    );
    assert.deepEqual(listingViolations(output, [EDITORCONFIG, KNIP, ARTIFACT]), []);

    // Incomplete: the recipe deleted after apply; an edited artifact is listed as a note, because
    // without a recipe its line has no level of its own.
    await applied([], [ARTIFACT]);
    await rm(CONFIG);
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    ({ stdout, stderr } = await runCli(directory, ["doctor"]));
    output = `${stdout}${stderr}`;
    assert.deepEqual(listingViolations(output, [ARTIFACT]), []);

    // A pending transaction lists the rollback's files under the phase line, and no artifact.
    await rm(SKILL, { recursive: true });
    await applied([], [ARTIFACT]);
    const root = ".calavera/.transactions/stopped";
    await mkdir(`${root}/backup`, { recursive: true });
    await writeJsonFile(JOURNAL, {
      schemaVersion: 1,
      transactionRoot: root,
      operations: [
        {
          staged: `${root}/staged/x`,
          target: ".agents/skills/x",
          backup: `${root}/backup/x`,
          hadTarget: false,
        },
      ],
    });
    ({ stdout, stderr } = await runCli(directory, ["doctor"]));
    output = `${stdout}${stderr}`;
    assert.ok(output.includes("  The rollback restores or removes .agents/skills/x."), output);
    assert.equal(countLines(output, ARTIFACT), 0, output);
  });
});

/** @param {string} output @param {string} text */
function countLines(output, text) {
  return output.split("\n").filter((line) => line.includes(text)).length;
}

test("doctor --json prints the phase, the items, and a check on every issue", async () => {
  await inProject(async (directory) => {
    await applied(["knip"], [ARTIFACT]);
    const { code, stdout } = await runCli(directory, ["doctor", "--json"]);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.phase, "applied");
    assert.ok(
      result.issues.every(
        (/** @type {{ check?: string }} */ { check }) => typeof check === "string",
      ),
    );
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.managedFiles.length, 1);
  });
});
