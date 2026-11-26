// Issue #994: `artifacts doctor` exits 1 and prints an overall verdict when an artifact's files
// are missing, are not managed by Calavera, or carry a local edit, so a script or an agent can
// tell a healthy project from a broken one. A healthy project exits 0. `artifacts status` reports
// the same problems but stays informational, so it still exits 0 (#1030 set the same split for
// `doctor`: errors fail the run, everything else is advisory).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { artifactDoctorVerdict, isArtifactHealthy } from "../src/artifact-status-report.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { createTemporaryFixture, json } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const ARTIFACT = "skill-project-goal";
// A skill installs as a directory, so the whole directory has to go for its files to be missing.
const SKILL_DIRECTORY = ".agents/skills/project-goal";
const SKILL_FILE = `${SKILL_DIRECTORY}/SKILL.md`;
const HEALTHY = "Calavera artifacts doctor found no problems.";
const PROBLEM = `Calavera artifacts doctor found problems with 1 artifact: ${ARTIFACT}.`;

/**
 * Runs the CLI in `cwd` and resolves with its exit code, whatever it is. A run killed by a signal
 * resolves with a null code, so it cannot pass as an exit 0.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * Runs apply on a project whose artifacts are installed and locked, so it reads as `applied`
 * (ADR-0020, Decision 2), and these tests check an applied project. Without a profile in the
 * state, the phase is `composed`, and artifacts doctor warns that the recipe is not applied yet.
 *
 * @param {string} root
 */
async function applyLocked(root) {
  const { code, stdout, stderr } = await runCli(root, ["apply", "--yes", "--no-install"]);
  assert.equal(code, 0, `apply exited ${code}\n${stdout}\n${stderr}`);
}

/**
 * A project whose recipe selects one skill, installed through the workspace payload, so the CLI
 * run that follows finds a lock entry, managed state, and the installed file.
 *
 * @param {string} label
 */
async function installedProject(label) {
  const fixture = await createTemporaryFixture(label, {
    "calavera.config.json": json({
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ id: ARTIFACT }],
    }),
  });
  const originalDirectory = process.cwd();
  try {
    process.chdir(fixture.root);
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      stubRegistry(new Map([[ARTIFACT, "0.2.1"]])),
    );
  } finally {
    process.chdir(originalDirectory);
  }
  await applyLocked(fixture.root);
  return fixture;
}

const problems = [
  {
    name: "a missing artifact",
    note: "files missing",
    /** @param {string} root */
    break: (root) => rm(join(root, SKILL_DIRECTORY), { recursive: true }),
  },
  {
    name: "a locally edited artifact",
    note: "locally edited",
    /** @param {string} root */
    break: (root) => writeFile(join(root, SKILL_FILE), "local edit\n"),
  },
];

const outputModes = [
  { label: "text", args: [] },
  { label: "--json", args: ["--json"] },
];

for (const { label, args } of outputModes) {
  test(`artifacts doctor exits 0 on a healthy project (${label} output)`, async () => {
    await using fixture = await installedProject("artifacts-doctor-healthy");

    const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "doctor", ...args]);

    assert.equal(code, 0, `artifacts doctor exited ${code}\n${stdout}\n${stderr}`);
    if (label === "--json") {
      const report = JSON.parse(stdout);
      assert.equal(report.ok, true);
      assert.equal(stderr, "");
      assert.deepEqual(
        report.artifacts.map(({ id }) => id),
        [ARTIFACT],
      );
    } else {
      const lines = stdout.trimEnd().split("\n");
      assert.equal(lines.at(-1), HEALTHY, stdout);
      assert.equal(stderr, "");
    }
  });

  for (const problem of problems) {
    test(`artifacts doctor exits 1 on ${problem.name} (${label} output)`, async () => {
      await using fixture = await installedProject("artifacts-doctor-problem");
      await problem.break(fixture.root);

      const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "doctor", ...args]);

      assert.equal(code, 1, `artifacts doctor exited ${code}\n${stdout}\n${stderr}`);
      if (label === "--json") {
        const report = JSON.parse(stdout);
        assert.equal(report.ok, false);
        assert.equal(stderr, "");
      } else {
        assert.match(stdout, new RegExp(`${ARTIFACT} .*${problem.note}`));
        // The verdict is an error, so it goes to stderr and closes the output.
        assert.equal(stderr.trimEnd(), PROBLEM);
        assert.ok(!stdout.includes(HEALTHY), stdout);
      }
    });

    test(`artifacts status still exits 0 on ${problem.name} (${label} output)`, async () => {
      await using fixture = await installedProject("artifacts-status-problem");
      await problem.break(fixture.root);

      const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "status", ...args]);

      assert.equal(code, 0, `artifacts status exited ${code}\n${stdout}\n${stderr}`);
      if (label === "--json") {
        assert.equal(JSON.parse(stdout).ok, false);
      } else {
        assert.match(stdout, new RegExp(`${ARTIFACT} .*${problem.note}`));
        assert.ok(!`${stdout}${stderr}`.includes("Calavera artifacts doctor"), stdout + stderr);
      }
    });
  }
}

// One healthy artifact cannot hide a broken one: `ok` needs every artifact to be healthy.
test("artifacts doctor exits 1 when one of two artifacts has a problem", async () => {
  await using fixture = await createTemporaryFixture("artifacts-doctor-two", {
    "calavera.config.json": json({
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ id: ARTIFACT }, { id: "skill-code-review" }],
    }),
  });
  const originalDirectory = process.cwd();
  try {
    process.chdir(fixture.root);
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      stubRegistry(
        new Map([
          [ARTIFACT, "0.2.1"],
          ["skill-code-review", "0.2.1"],
        ]),
      ),
    );
  } finally {
    process.chdir(originalDirectory);
  }
  await applyLocked(fixture.root);
  await writeFile(join(fixture.root, SKILL_FILE), "local edit\n");

  const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "doctor", "--json"]);
  assert.equal(code, 1, `artifacts doctor exited ${code}\n${stdout}\n${stderr}`);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.artifacts.map(({ id, locallyEdited }) => [id, locallyEdited]).sort(),
    [
      [ARTIFACT, true],
      ["skill-code-review", false],
    ].sort(),
  );

  const text = await runCli(fixture.root, ["artifacts", "doctor"]);
  assert.equal(text.code, 1, text.stdout + text.stderr);
  assert.equal(text.stderr.trimEnd(), PROBLEM);
});

// Owner decision on #994 (2026-11-21): a selection without a lock entry is the normal state
// between init and apply, so doctor names it in a note, as doctor's "Missing managed AI skill"
// warning does, and exits 0 when nothing else is wrong. `ok` follows the exit status.
const NOT_INSTALLED_NOTE = `Selected artifact not installed yet: ${ARTIFACT}. Run npm create project-calavera artifacts install, or apply, to install it.`;

/** @param {string} label @param {object[]} ai */
function recipeFixture(label, ai) {
  return createTemporaryFixture(label, {
    "calavera.config.json": json({ ...buildRecipe("minimal", [], "npm"), ai }),
  });
}

test("artifacts doctor exits 0 with a note on a selected artifact that is not installed yet", async () => {
  await using fixture = await recipeFixture("artifacts-doctor-unlocked", [{ id: ARTIFACT }]);

  const text = await runCli(fixture.root, ["artifacts", "doctor"]);
  assert.equal(
    text.code,
    0,
    `artifacts doctor exited ${text.code}\n${text.stdout}\n${text.stderr}`,
  );
  assert.match(text.stdout, new RegExp(`${ARTIFACT} +not installed`));
  // The phase line and the note are warnings, so they go to stderr; the healthy verdict closes
  // stdout (ADR-0020, Decision 4: composed is a warning that does not fail artifacts doctor).
  assert.deepEqual(text.stderr.trimEnd().split("\n"), [
    "The recipe in calavera.config.json is not applied yet, so run npm create project-calavera apply.",
    NOT_INSTALLED_NOTE,
  ]);
  assert.equal(text.stdout.trimEnd().split("\n").at(-1), HEALTHY);

  const asJson = await runCli(fixture.root, ["artifacts", "doctor", "--json"]);
  assert.equal(asJson.code, 0, asJson.stdout + asJson.stderr);
  const report = JSON.parse(asJson.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.artifacts[0].version, null);

  // Status output gets no note and no verdict.
  const status = await runCli(fixture.root, ["artifacts", "status"]);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.ok(!`${status.stdout}${status.stderr}`.includes("not installed yet"), status.stdout);
});

test("a selection that is not installed yet does not hide a broken installed artifact", async () => {
  await using fixture = await installedProject("artifacts-doctor-unlocked-and-broken");
  await writeFile(
    join(fixture.root, "calavera.config.json"),
    json({
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ id: ARTIFACT }, { id: "skill-code-review" }],
    }),
  );
  await writeFile(join(fixture.root, SKILL_FILE), "local edit\n");

  const text = await runCli(fixture.root, ["artifacts", "doctor"]);
  assert.equal(text.code, 1, text.stdout + text.stderr);
  assert.deepEqual(text.stderr.trimEnd().split("\n"), [
    "Selected artifact not installed yet: skill-code-review. Run npm create project-calavera artifacts install, or apply, to install it.",
    PROBLEM,
  ]);

  const asJson = await runCli(fixture.root, ["artifacts", "doctor", "--json"]);
  assert.equal(asJson.code, 1, asJson.stdout + asJson.stderr);
  assert.equal(JSON.parse(asJson.stdout).ok, false);
});

test("the verdict names every artifact with a problem, and only those", () => {
  /** @param {string} id @param {Partial<{ installed: boolean, managed: boolean, locallyEdited: boolean, selected: boolean | null, installCommand: string | null }>} health */
  const entry = (id, health) => {
    const merged = {
      id,
      version: /** @type {string | null} */ ("0.2.1"),
      installCommand: /** @type {string | null} */ (null),
      selected: /** @type {boolean | null} */ (true),
      installed: true,
      managed: true,
      locallyEdited: false,
      ...health,
    };
    // The condition the phase function gives these fields (ADR-0020, Decision 3).
    const name = !merged.installed
      ? "missing"
      : merged.locallyEdited
        ? "edited"
        : !merged.managed
          ? "unrecorded"
          : "current";
    return { ...merged, condition: { name, reason: "" } };
  };
  const verdict = (/** @type {ReturnType<typeof entry>[]} */ artifacts) =>
    artifactDoctorVerdict(
      /** @type {Parameters<typeof artifactDoctorVerdict>[0]} */ (
        /** @type {unknown} */ ({
          ok: artifacts.every(isArtifactHealthy),
          artifacts,
          phase: "applied",
          phaseLine: { level: "info", message: "The phase is applied." },
          formatterFailures: [],
          managedFilePlanProblem: null,
        })
      ),
    );

  /** @param {string} id */
  const notInstalled = (id) => ({
    ...entry(id, { installed: false, managed: false }),
    version: null,
    installCommand: "pnpm dlx create-project-calavera artifacts install",
    condition: { name: "pending", reason: "" },
  });
  assert.equal(isArtifactHealthy(entry("a", {})), true);
  assert.equal(isArtifactHealthy(notInstalled("a")), true);
  // ADR-0020, Decision 4: a selected artifact fails when its condition is a problem.
  for (const problem of [{ installed: false }, { managed: false }, { locallyEdited: true }]) {
    assert.equal(isArtifactHealthy(entry("a", problem)), false, JSON.stringify(problem));
  }
  assert.equal(
    isArtifactHealthy({ ...entry("a", {}), condition: { name: "unreadable", reason: "" } }),
    false,
  );
  // #1111 and owner decision 6: a lock entry the recipe no longer selects is a warning, whether
  // its files were deleted, edited, or are not recorded.
  for (const problem of [{ installed: false }, { managed: false }, { locallyEdited: true }]) {
    assert.equal(isArtifactHealthy(entry("a", { ...problem, selected: false })), true);
  }
  // Without a recipe, `selected` is null, and the phase line's error decides the verdict.
  assert.equal(isArtifactHealthy(entry("a", { installed: false, selected: null })), true);
  assert.deepEqual(verdict([]), [{ level: "success", message: HEALTHY }]);
  assert.deepEqual(verdict([entry("a", {})]), [{ level: "success", message: HEALTHY }]);
  assert.deepEqual(verdict([notInstalled("b")]), [
    {
      level: "warn",
      message:
        "Selected artifact not installed yet: b. Run pnpm dlx create-project-calavera artifacts install, or apply, to install it.",
    },
    { level: "success", message: HEALTHY },
  ]);
  assert.deepEqual(verdict([entry("a", {}), notInstalled("b"), notInstalled("c")]), [
    {
      level: "warn",
      message:
        "Selected artifacts not installed yet: b, c. Run pnpm dlx create-project-calavera artifacts install, or apply, to install them.",
    },
    { level: "success", message: HEALTHY },
  ]);
  assert.deepEqual(verdict([entry("a", {}), entry("b", { locallyEdited: true })]), [
    { level: "error", message: "Calavera artifacts doctor found problems with 1 artifact: b." },
  ]);
  assert.deepEqual(
    verdict([
      entry("a", {}),
      entry("b", { installed: false }),
      entry("c", { managed: false }),
      entry("d", { locallyEdited: true }),
    ]),
    [
      {
        level: "error",
        message: "Calavera artifacts doctor found problems with 3 artifacts: b, c, d.",
      },
    ],
  );
});

// #1111 (owner decision of 2026-11-21 on #994, ADR-0020 Decision 4): a lock entry the recipe no
// longer selects, whose files were deleted, is a leftover record, not a broken project. Both
// commands print it as a warning that names the entry once, with the command that drops the entry,
// and doctor exits 0 when nothing else is wrong. A selected artifact whose files were deleted
// still fails.
const INSTALL_COMMAND = "npm create project-calavera artifacts install";
const LEFTOVER_LINES = [
  `${ARTIFACT}  0.2.1 (latest), files missing`,
  `  Not selected, files missing: the recipe no longer selects this artifact, and some or all of its files were deleted, so its lock entry is a leftover. artifacts install removes the entry when it can also install what the recipe selects, and otherwise stops and names the problem: ${INSTALL_COMMAND}`,
];

/**
 * A project whose recipe no longer selects the artifact `installedProject` installed, and whose
 * files for it were deleted. The state still records the files, as it does until `clean` runs.
 *
 * @param {string} label
 * @param {object[]} [ai] The recipe's selections after the edit.
 */
async function leftoverProject(label, ai = []) {
  const fixture = await installedProject(label);
  await writeFile(
    join(fixture.root, "calavera.config.json"),
    json({ ...buildRecipe("minimal", [], "npm"), ai }),
  );
  await rm(join(fixture.root, SKILL_DIRECTORY), { recursive: true });
  return fixture;
}

/** @param {string} text */
const mentions = (text) => text.split(ARTIFACT).length - 1;

test("artifacts doctor warns about a deselected lock entry whose files were deleted, and exits 0 (text output)", async () => {
  await using fixture = await leftoverProject("artifacts-doctor-leftover-text");

  const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "doctor"]);

  assert.equal(code, 0, `artifacts doctor exited ${code}\n${stdout}\n${stderr}`);
  // The warning goes to stderr; the healthy verdict closes stdout.
  assert.deepEqual(stderr.trimEnd().split("\n"), LEFTOVER_LINES);
  assert.equal(stdout.trimEnd().split("\n").at(-1), HEALTHY);
  assert.equal(mentions(stdout + stderr), 1, stdout + stderr);
});

test("artifacts doctor --json reports a deselected lock entry whose files were deleted as ok, with the command that drops it", async () => {
  await using fixture = await leftoverProject("artifacts-doctor-leftover-json");

  const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "doctor", "--json"]);

  assert.equal(code, 0, `artifacts doctor exited ${code}\n${stdout}\n${stderr}`);
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.artifacts.map(({ id, selected, installed, installCommand }) => ({
      id,
      selected,
      installed,
      installCommand,
    })),
    [{ id: ARTIFACT, selected: false, installed: false, installCommand: INSTALL_COMMAND }],
  );
});

test("artifacts status classifies a deselected lock entry whose files were deleted as artifacts doctor does", async () => {
  await using fixture = await leftoverProject("artifacts-status-leftover");

  const text = await runCli(fixture.root, ["artifacts", "status"]);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.deepEqual(text.stderr.trimEnd().split("\n"), LEFTOVER_LINES);
  assert.ok(!text.stdout.includes("Calavera artifacts doctor"), text.stdout);

  const status = JSON.parse((await runCli(fixture.root, ["artifacts", "status", "--json"])).stdout);
  const doctor = JSON.parse((await runCli(fixture.root, ["artifacts", "doctor", "--json"])).stdout);
  assert.equal(status.ok, true);
  assert.deepEqual(status.artifacts, doctor.artifacts);
});

test("the command the warning names drops the leftover lock entry, so doctor then reports nothing", async () => {
  await using fixture = await leftoverProject("artifacts-doctor-leftover-remedy");
  const report = JSON.parse((await runCli(fixture.root, ["artifacts", "doctor", "--json"])).stdout);
  // The runner prefix is the recipe's npm runner; the rest is the CLI command the test runs.
  const [, , , ...remedy] = report.artifacts[0].installCommand.split(" ");
  assert.deepEqual(remedy, ["artifacts", "install"]);

  const install = await runCli(fixture.root, remedy);
  assert.equal(install.code, 0, install.stdout + install.stderr);

  const after = await runCli(fixture.root, ["artifacts", "doctor", "--json"]);
  assert.equal(after.code, 0, after.stdout + after.stderr);
  assert.deepEqual(JSON.parse(after.stdout).artifacts, []);
  const text = await runCli(fixture.root, ["artifacts", "doctor"]);
  assert.equal(text.stderr, "");
  assert.equal(mentions(text.stdout), 0, text.stdout);
});

test("a deselected lock entry whose files were deleted does not hide a selected artifact whose files were deleted", async () => {
  await using fixture = await createTemporaryFixture("artifacts-doctor-leftover-and-missing", {
    "calavera.config.json": json({
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ id: ARTIFACT }, { id: "skill-code-review" }],
    }),
  });
  const originalDirectory = process.cwd();
  try {
    process.chdir(fixture.root);
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      stubRegistry(
        new Map([
          [ARTIFACT, "0.2.1"],
          ["skill-code-review", "0.2.1"],
        ]),
      ),
    );
  } finally {
    process.chdir(originalDirectory);
  }
  await applyLocked(fixture.root);
  await writeFile(
    join(fixture.root, "calavera.config.json"),
    json({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: "skill-code-review" }] }),
  );
  await rm(join(fixture.root, SKILL_DIRECTORY), { recursive: true });
  await rm(join(fixture.root, ".agents/skills/code-review"), { recursive: true });

  const text = await runCli(fixture.root, ["artifacts", "doctor"]);
  assert.equal(text.code, 1, text.stdout + text.stderr);
  const stderr = text.stderr.trimEnd().split("\n");
  assert.equal(
    stderr.at(-1),
    "Calavera artifacts doctor found problems with 1 artifact: skill-code-review.",
  );
  assert.ok(stderr.includes(LEFTOVER_LINES[0]), text.stderr);
  assert.equal(mentions(text.stdout + text.stderr), 1, text.stdout + text.stderr);

  const asJson = await runCli(fixture.root, ["artifacts", "doctor", "--json"]);
  assert.equal(asJson.code, 1, asJson.stdout + asJson.stderr);
  const report = JSON.parse(asJson.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.artifacts.find(({ id }) => id === "skill-code-review").installCommand, null);
});

// A hook installs two files. With one of them deleted, the phase function gives the deselected
// entry the `missing` condition, so doctor warns about it as it does for a deleted skill.
test("a deselected hook with one of its two files deleted is a warning, not a failure", async () => {
  const HOOK = "hook-block-dangerous-commands";
  await using fixture = await createTemporaryFixture("artifacts-doctor-leftover-hook", {
    "calavera.config.json": json({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: HOOK }] }),
  });
  const originalDirectory = process.cwd();
  try {
    process.chdir(fixture.root);
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      stubRegistry(new Map([[HOOK, "0.4.0"]])),
    );
  } finally {
    process.chdir(originalDirectory);
  }
  await applyLocked(fixture.root);
  await writeFile(
    join(fixture.root, "calavera.config.json"),
    json({ ...buildRecipe("minimal", [], "npm"), ai: [] }),
  );
  await rm(
    join(fixture.root, ".agents/hooks/claude-code/block-dangerous-commands.settings-fragment.json"),
  );

  // In process as well, so mutation testing sees which code the report runs.
  process.chdir(fixture.root);
  try {
    const report = /** @type {{ ok: boolean, artifacts: { installed: boolean }[] }} */ (
      await runArtifactCommand({
        config: "calavera.config.json",
        dryRun: false,
        artifactAction: "doctor",
      })
    );
    assert.equal(report.artifacts[0]?.installed, false);
    assert.equal(report.ok, true);
  } finally {
    process.chdir(originalDirectory);
  }

  const text = await runCli(fixture.root, ["artifacts", "doctor"]);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.deepEqual(text.stderr.trimEnd().split("\n"), [
    `${HOOK}  0.4.0 (latest), files missing`,
    LEFTOVER_LINES[1],
  ]);
  assert.equal(text.stdout.trimEnd().split("\n").at(-1), HEALTHY);
});

// ADR-0020, Decision 7: a lock that fails the phase function's shape check stops every artifact
// command with the same error, which names the entry by its position, and both commands exit 1.
// Before the phase, status reported such a lock and the deselected entry failed; that fallback is
// gone.
test("a lock entry the phase function refuses stops artifacts status and artifacts doctor alike", async () => {
  await using fixture = await leftoverProject("artifacts-doctor-leftover-refused");
  const lockPath = join(fixture.root, ".calavera/artifacts.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.artifacts[0].version = "not-a-version";
  await writeFile(lockPath, json(lock));
  const refusal =
    ".calavera/artifacts.lock.json artifacts[0] has no valid version, so Calavera cannot check it. Restore the lock from version control, or run artifacts install to write it again.";

  // In process as well, so mutation testing sees which code the report runs.
  const originalDirectory = process.cwd();
  process.chdir(fixture.root);
  try {
    for (const artifactAction of ["status", "doctor"]) {
      await assert.rejects(
        runArtifactCommand({ config: "calavera.config.json", dryRun: false, artifactAction }),
        { message: refusal },
      );
    }
  } finally {
    process.chdir(originalDirectory);
  }

  for (const action of ["status", "doctor"]) {
    const run = await runCli(fixture.root, ["artifacts", action, "--json"]);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.ok(`${run.stdout}${run.stderr}`.includes(refusal), run.stdout + run.stderr);
  }
});

// The remedy does not promise more than `artifacts install` does: the install stops when a
// selection's file already exists without a state record, and then keeps the leftover entry.
test("the leftover note does not promise that artifacts install drops the entry when the install stops", async () => {
  await using fixture = await leftoverProject("artifacts-doctor-leftover-install-stops", [
    { id: "skill-code-review" },
  ]);
  await mkdir(join(fixture.root, ".agents/skills/code-review"), { recursive: true });
  await writeFile(join(fixture.root, ".agents/skills/code-review/SKILL.md"), "my own skill\n");

  const text = await runCli(fixture.root, ["artifacts", "doctor"]);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  const stderr = text.stderr.trimEnd().split("\n");
  assert.deepEqual(stderr.slice(0, 2), LEFTOVER_LINES);
  assert.match(
    LEFTOVER_LINES[1],
    /removes the entry when it can also install what the recipe selects, and otherwise stops/,
  );

  const originalDirectory = process.cwd();
  try {
    process.chdir(fixture.root);
    await assert.rejects(
      runArtifactCommand(
        { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
        stubRegistry(new Map([["skill-code-review", "0.2.1"]])),
      ),
    );
  } finally {
    process.chdir(originalDirectory);
  }
  const lock = JSON.parse(
    await readFile(join(fixture.root, ".calavera/artifacts.lock.json"), "utf8"),
  );
  assert.deepEqual(
    lock.artifacts.map(({ id }) => id),
    [ARTIFACT],
  );
});
