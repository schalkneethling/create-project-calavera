// #1112 (ADR-0020, Decisions 1, 4, 5, and 8): `artifacts status`, `artifacts doctor`, and the
// read-only `artifact_status` MCP tool read the project phase from `deriveProjectPhase`. Each
// result gains `phase`, a phase line, and each artifact's `condition`; the artifact verdict reads
// the condition; `artifacts doctor` stops recovering a pending transaction; and `--check-updates`
// writes the cache block only in a phase whose records it belongs to.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { fileURLToPath } from "node:url";

import { readArtifactStatus, runArtifactCommand } from "../src/artifact-lifecycle.js";
import {
  artifactDoctorVerdict,
  formatArtifactStatus,
  formatPhaseReport,
} from "../src/artifact-status-report.js";
import { applyRecipeObject } from "../src/index.js";
import { deriveProjectPhase } from "../src/project-phase.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";
import { writeVitePlusFormatter } from "./vite-plus-fixtures.mjs";

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
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-status-phase-"));
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

/** @param {"status" | "doctor"} artifactAction @param {Record<string, unknown>} [extra] */
const run = (artifactAction, extra = {}, services = registry()) =>
  runArtifactCommand({ config: CONFIG, dryRun: false, artifactAction, ...extra }, services);

/**
 * Runs the CLI in `cwd` and resolves with its exit code, standard output, and standard error.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
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

/** @param {{ artifacts: Array<{ id: string, condition?: unknown }> }} result @param {string} id */
const conditionOf = (result, id) => result.artifacts.find((item) => item.id === id)?.condition;

test("each artifact command reports the phase and each artifact's condition from the phase function", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    const phase = await deriveProjectPhase({ config: CONFIG });
    for (const result of [
      await run("status"),
      await run("doctor"),
      await readArtifactStatus({ config: CONFIG }),
    ]) {
      assert.equal(result.phase, "drifted");
      assert.deepEqual(conditionOf(result, ARTIFACT), phase.artifacts[0]?.condition);
    }
  });
});

test("an output that cannot be hashed is unreadable instead of stopping the report", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT, OTHER]);
    await rm(SKILL, { recursive: true });
    await writeFile(SKILL, "a file where the folder was\n");
    const status = await run("status");
    assert.equal(
      /** @type {{ name: string }} */ (conditionOf(status, ARTIFACT)).name,
      "unreadable",
    );
    assert.equal(/** @type {{ name: string }} */ (conditionOf(status, OTHER)).name, "current");
    assert.equal((await run("doctor")).ok, false);
  });
});

test("a lock entry the phase function refuses stops every artifact command with the same error", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    const lock = await readJsonFile(LOCK);
    lock.artifacts[0].version = null;
    await writeJsonFile(LOCK, lock);
    const message = `${LOCK} artifacts[0] has no valid version, so Calavera cannot check it. Restore the lock from version control, or run artifacts install to write it again.`;
    await assert.rejects(run("status"), { message });
    await assert.rejects(run("doctor"), { message });
    await assert.rejects(readArtifactStatus({ config: CONFIG }), { message });
  });
});

test("a deselected lock entry is a warning whatever happened to its files, and a selected one fails", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT, OTHER]);
    await writeJsonFile(CONFIG, recipeWith([], [ARTIFACT]));
    // Owner decision 6: deselected and edited, or deselected and unrecorded, is a warning.
    await writeFile(join(OTHER_SKILL, "SKILL.md"), "edited\n");
    let doctor = await run("doctor");
    assert.equal(/** @type {{ name: string }} */ (conditionOf(doctor, OTHER)).name, "edited");
    assert.equal(doctor.ok, true);
    assert.ok(
      formatArtifactStatus(doctor).some(
        ({ level, message }) => level === "warn" && message.startsWith(`${OTHER}  `),
      ),
    );
    const state = await readJsonFile(STATE);
    state.aiArtifacts = state.aiArtifacts.filter(
      (/** @type {{ path: string }} */ { path }) => path !== OTHER_SKILL,
    );
    await writeJsonFile(STATE, state);
    doctor = await run("doctor");
    assert.equal(/** @type {{ name: string }} */ (conditionOf(doctor, OTHER)).name, "unrecorded");
    assert.equal(doctor.ok, true);
    // A deselected entry with edited files keeps no install command: only a missing one does (#1111).
    assert.equal(doctor.artifacts.find(({ id }) => id === OTHER)?.installCommand, null);

    // The selected artifact edited fails.
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    assert.equal((await run("doctor")).ok, false);
  });
});

test("a selection without a lock entry whose recorded files changed names the change, not an install", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await writeJsonFile(LOCK, { schemaVersion: 1, artifacts: [] });
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    const doctor = await run("doctor");
    const [entry] = doctor.artifacts;
    assert.equal(entry?.condition.name, "edited");
    // The fields agree with the condition.
    assert.equal(entry?.installed, true);
    assert.equal(entry?.managed, true);
    assert.equal(entry?.locallyEdited, true);
    assert.equal(doctor.ok, false);
    const lines = formatArtifactStatus(doctor).map(({ message }) => message);
    assert.equal(
      lines.some((line) => line.includes("not installed")),
      false,
      lines.join("\n"),
    );
    assert.ok(
      lines.includes(`${ARTIFACT}  no lock entry (latest), locally edited`),
      lines.join("\n"),
    );
    assert.ok(lines.includes(`  ${entry?.condition.reason}`), lines.join("\n"));
    // The verdict names no selection as not installed yet.
    const verdict = artifactDoctorVerdict(doctor).map(({ message }) => message);
    assert.equal(
      verdict.some((line) => line.startsWith("Selected artifact not installed yet")),
      false,
    );
  });
});

test("a deselected entry with edited files keeps its line and its note together on stderr", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT, OTHER]);
    await writeJsonFile(CONFIG, recipeWith([], [ARTIFACT]));
    await writeFile(join(OTHER_SKILL, "SKILL.md"), "edited\n");
    const lines = formatArtifactStatus(await run("doctor"));
    const index = lines.findIndex(({ message }) => message.startsWith(`${OTHER}  `));
    assert.equal(lines[index]?.level, "warn");
    assert.equal(lines[index + 1]?.level, "warn");
    assert.match(lines[index + 1]?.message ?? "", /Not selected/);
  });
});

test("--check-updates writes nothing into an incomplete project that still has its state file", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    // The recipe deleted after apply: the state and the lock remain.
    await rm(CONFIG);
    await rm(".gitignore", { force: true });
    const before = await snapshotDirectory();
    const status = await run("status", { checkUpdates: true });
    assert.equal(status.phase, "incomplete");
    assert.deepEqual(status.ignoreChanges, []);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("an incomplete line names the package folders that remain", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await rm(STATE);
    const doctor = await run("doctor");
    assert.equal(doctor.phase, "incomplete");
    assert.match(
      doctor.phaseLine.message,
      /\.calavera\/artifacts\.lock\.json, and \.calavera\/packages remain/,
    );
  });
});

test("artifacts doctor fails in a phase whose line is an error, and passes in composed", async () => {
  await inProject(async () => {
    // unmanaged
    let doctor = await run("doctor");
    assert.equal(doctor.phase, "unmanaged");
    assert.equal(doctor.ok, false);
    assert.equal(doctor.phaseLine.level, "error");
    const status = await run("status");
    assert.equal(status.phaseLine.level, "info");
    assert.equal(status.phaseLine.message, doctor.phaseLine.message);
    // status keeps doctor's verdict in ok, and still exits 0 on the command line.
    assert.equal(status.ok, false);

    // composed: a warning in artifacts doctor that does not fail it.
    await writeJsonFile(CONFIG, recipeWith([], [ARTIFACT]));
    doctor = await run("doctor");
    assert.equal(doctor.phase, "composed");
    assert.equal(doctor.phaseLine.level, "warn");
    assert.equal(doctor.ok, true);

    // incomplete: recipe and lock without a state.
    await runArtifactCommand(
      { config: CONFIG, dryRun: false, artifactAction: "install" },
      registry(),
    );
    await rm(STATE);
    doctor = await run("doctor");
    assert.equal(doctor.phase, "incomplete");
    assert.equal(doctor.ok, false);
    // Without a recipe, an artifact's condition has no level of its own: the phase decides.
    await rm(CONFIG);
    doctor = await run("doctor");
    assert.equal(doctor.artifacts[0]?.selected, null);
    assert.equal(doctor.ok, false);
  });
});

test("an ejected project fails artifacts doctor, and a bootstrapped one only warns", async () => {
  await inProject(async () => {
    await writeFile(
      ".gitignore",
      "# calavera:ejected:start\n# create-project-calavera eject removed Calavera's records from this project.\n# calavera:ejected:end\n",
    );
    const ejected = await run("doctor");
    assert.equal(ejected.phase, "ejected");
    assert.equal(ejected.ok, false);
    await rm(".gitignore");
    const { code } = await runCli(process.cwd(), ["--init", "--yes", "--mcp-harness", "skip"]);
    assert.equal(code, 0);
    const bootstrapped = await run("doctor");
    assert.equal(bootstrapped.phase, "bootstrapped");
    assert.equal(bootstrapped.phaseLine.level, "warn");
    assert.equal(bootstrapped.ok, true);
  });
});

test("a managed-file plan problem and a formatter failure fail artifacts doctor", async () => {
  await inProject(async () => {
    await applied(["knip"], []);
    await writeJsonFile(CONFIG, {
      ...recipeWith(["knip"], []),
      integrationOptions: "not an object",
    });
    let doctor = await run("doctor");
    assert.match(doctor.managedFilePlanProblem ?? "", /^Calavera cannot plan the managed files/);
    assert.equal(doctor.ok, false);

    await writeJsonFile(CONFIG, recipeWith(["knip"], []));
    await writeJsonFile("package.json", { scripts: {}, devDependencies: { "vite-plus": "1.0.0" } });
    doctor = await run("doctor");
    assert.deepEqual(
      doctor.formatterFailures.map(({ kind }) => kind),
      ["not-installed"],
    );
    assert.equal(doctor.ok, false);
  });
});

test("a drifted project whose artifacts are current names what drifted in the phase line", async () => {
  await inProject(async () => {
    await applied(["knip"], [ARTIFACT]);
    await rm(KNIP);
    const doctor = await run("doctor");
    assert.equal(doctor.phase, "drifted");
    assert.equal(
      doctor.phaseLine.message,
      `The phase is drifted. No artifact changed: the managed file ${KNIP} did, which doctor reports.`,
    );
    // The managed file's own condition is doctor's to report, so artifacts doctor still passes.
    assert.equal(doctor.ok, true);
  });
});

test("the read-only status tool runs no project code and says when a managed file was not checked", async () => {
  await inProject(async (directory) => {
    await applied(["knip"], []);
    await writeJsonFile("package.json", { scripts: {}, devDependencies: { "vite-plus": "1.0.0" } });
    const ran = join(directory, "vp-ran");
    await writeVitePlusFormatter(directory, { bin: { vp: "./bin/sentinel.mjs" } });
    await writeFile(
      join(directory, "node_modules/vite-plus/bin/sentinel.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "");\n`,
    );
    const knip = await readJsonFile(KNIP);
    await writeJsonFile(KNIP, { ...knip, entry: ["src/main.ts"] });
    const tool = await readArtifactStatus({ config: CONFIG });
    await assert.rejects(access(ran), { code: "ENOENT" });
    assert.equal(tool.phase, "applied");
    assert.match(tool.phaseLine.message, /does not run the project's formatter, so run doctor/);
    // The CLI commands load the formatter, as apply does (ADR-0020, Decision 3).
    await run("status");
    await access(ran);
  });
});

test("artifacts doctor reports a pending transaction without recovering it or resolving anything", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    const root = ".calavera/.transactions/stopped";
    // An artifact folder the stopped operation was creating, which the rollback removes.
    const STOPPED = ".agents/skills/stopped";
    await mkdir(`${root}/backup`, { recursive: true });
    await writeJsonFile(JOURNAL, {
      schemaVersion: 1,
      transactionRoot: root,
      operations: [
        {
          staged: `${root}/staged/stopped`,
          target: STOPPED,
          backup: `${root}/backup/stopped`,
          hadTarget: false,
        },
      ],
    });
    const before = await snapshotDirectory();
    const services = registry();
    for (const checkUpdates of [false, true]) {
      const doctor = await run("doctor", { checkUpdates }, services);
      assert.equal(doctor.phase, "pending-transaction");
      assert.equal(doctor.ok, false);
      assert.equal(doctor.command, "artifacts doctor");
      assert.deepEqual(doctor.rollbackFiles, [STOPPED]);
      assert.equal(doctor.phaseLine.level, "error");
      assert.match(doctor.phaseLine.message, /artifacts status/);
    }
    assert.deepEqual(services.requests, []);
    assert.deepEqual(await snapshotDirectory(), before);
    const { code } = await runCli(process.cwd(), ["artifacts", "doctor", "--json"]);
    assert.equal(code, 1);
    // artifacts status still recovers the transaction, then reports the recovered phase.
    const status = await run("status");
    assert.notEqual(status.phase, "pending-transaction");
    await assert.rejects(access(JOURNAL), { code: "ENOENT" });
  });
});

test("--check-updates writes nothing into a project outside composed, applied, and drifted", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    // incomplete: the recipe and the lock remain, the state is gone, as eject --yes leaves them.
    await rm(STATE);
    await rm(".gitignore", { force: true });
    const before = await snapshotDirectory();
    const services = registry();
    const status = await run("status", { checkUpdates: true }, services);
    assert.equal(status.phase, "incomplete");
    assert.deepEqual(status.ignoreChanges, []);
    assert.ok(services.requests.length > 0);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("--check-updates writes nothing into a composed project that has no state file", async () => {
  await inProject(async () => {
    await writeJsonFile(CONFIG, recipeWith([], [ARTIFACT]));
    const before = await snapshotDirectory();
    const status = await run("status", { checkUpdates: true });
    assert.equal(status.phase, "composed");
    assert.deepEqual(status.ignoreChanges, []);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("--check-updates still records the cache block in an applied project", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await rm(".gitignore", { force: true });
    const status = await run("status", { checkUpdates: true });
    assert.equal(status.phase, "applied");
    assert.equal(status.ignoreChanges.length, 1);
  });
});

test("a formatter that cannot format the state skips the cache block: a note in status, an error in doctor", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await rm(".gitignore", { force: true });
    // vite-plus declared but not installed, so the state cannot be formatted for the block.
    await writeJsonFile("package.json", { scripts: {}, devDependencies: { "vite-plus": "1.0.0" } });
    const before = await snapshotDirectory();
    const problem =
      "Calavera did not record the artifact cache block in .gitignore, because the project's formatter could not format .calavera/state.json, so this report resolved packages through a temporary cache and wrote nothing. This is not a finding about the project's phase or an artifact. The project uses Vite+, but Calavera cannot find its vite-plus package, so it cannot format the managed files the way apply does, and apply stops on the same thing. Run vp install, then run the command again.";
    const services = registry();
    const status = await run("status", { checkUpdates: true }, services);
    assert.equal(status.cacheBlockProblem, problem);
    assert.deepEqual(status.ignoreChanges, []);
    assert.ok(services.requests.length > 0, "the update check still ran");
    assert.deepEqual(await snapshotDirectory(), before);
    assert.ok(
      formatPhaseReport(status).some(
        ({ level, message }) => level === "info" && message === problem,
      ),
    );
    const doctor = await run("doctor", { checkUpdates: true });
    assert.equal(doctor.cacheBlockProblem, problem);
    assert.equal(doctor.ok, false);
    assert.ok(
      formatPhaseReport(doctor).some(
        ({ level, message }) => level === "error" && message === problem,
      ),
    );
    assert.match(artifactDoctorVerdict(doctor).at(-1)?.message ?? "", /the artifact cache block/);
    assert.deepEqual(await snapshotDirectory(), before);
    // The dry run stops where the command would, so it reports the same problem.
    assert.equal(
      (await run("status", { checkUpdates: true, dryRun: true })).cacheBlockProblem,
      problem,
    );
    assert.deepEqual(await snapshotDirectory(), before);
    // Without --check-updates, no block is planned, so there is no cache block problem.
    assert.equal((await run("status")).cacheBlockProblem, null);
  });
});

test("--check-updates records the cache block in a drifted project", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await rm(".gitignore", { force: true });
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    const status = await run("status", { checkUpdates: true });
    assert.equal(status.phase, "drifted");
    assert.equal(status.ignoreChanges.length, 1);
  });
});

test("an installed selection without a lock entry is named as installed, not as not installed yet", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await writeJsonFile(LOCK, { schemaVersion: 1, artifacts: [] });
    const doctor = await run("doctor");
    const [entry] = doctor.artifacts;
    assert.equal(entry?.condition.name, "pending");
    assert.equal(entry?.installed, true);
    const lines = formatArtifactStatus(doctor).map(({ message }) => message);
    assert.equal(
      lines.some((line) => line.includes("not installed")),
      false,
      lines.join("\n"),
    );
    assert.ok(lines.includes(`${ARTIFACT}  installed, no lock entry (latest)`), lines.join("\n"));
    assert.ok(lines.includes(`  ${entry?.condition.reason}`), lines.join("\n"));
    assert.ok(
      lines.includes(`  Record it in the lock: ${entry?.installCommand}`),
      lines.join("\n"),
    );
    const verdict = artifactDoctorVerdict(doctor).map(({ message }) => message);
    assert.equal(
      verdict.some((line) => line.startsWith("Selected artifact not installed yet")),
      false,
    );
    assert.equal(doctor.ok, true);
  });
});

test("a selected artifact whose files cannot be read says so on its line", async () => {
  await inProject(async () => {
    await applied([], [ARTIFACT]);
    await rm(SKILL, { recursive: true });
    await writeFile(SKILL, "a file where the folder was\n");
    const lines = formatArtifactStatus(await run("doctor")).map(({ message }) => message);
    assert.ok(
      lines.includes(`${ARTIFACT}  0.1.0 (latest), files cannot be read`),
      lines.join("\n"),
    );
  });
});

test("the pending-transaction line in the text output names the listed files, not a JSON field", async () => {
  await inProject(async () => {
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
    const doctor = await run("doctor");
    assert.match(doctor.remedy, /files in rollbackFiles/);
    assert.equal(doctor.phaseLine.message.includes("rollbackFiles"), false);
    assert.match(
      doctor.phaseLine.message,
      /Save any edits to the files the rollback restores or removes first/,
    );
  });
});

test("the phase line comes first in the text output of both commands", async () => {
  await inProject(async (directory) => {
    await applied([], [ARTIFACT]);
    for (const action of ["status", "doctor"]) {
      const { stdout } = await runCli(directory, ["artifacts", action]);
      assert.equal(stdout.split("\n")[0], "The phase is applied.", stdout);
    }
  });
});
