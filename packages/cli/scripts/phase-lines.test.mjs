// #1112 (ADR-0020, Decisions 4 and 5): the phase line each artifact command starts with, the notes
// about the `ejected` marker, the phase report's other lines, and artifacts doctor's verdict. These
// tests build the phase function's result by hand, so each rule of the wording has a test.
import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactDoctorVerdict,
  formatArtifactStatus,
  formatPhaseReport,
} from "../src/artifact-status-report.js";
import { phaseLine, phaseNotes } from "../src/phase-lines.js";

const recipe = { packageManager: "pnpm" };
const CONFIG = "config/calavera.json";
const RUN = "pnpm dlx create-project-calavera";
const FLAGS = `--config ${CONFIG}`;

/**
 * A phase function result with every field, overridden by `fields`.
 *
 * @param {Record<string, unknown>} fields
 * @returns {import("../src/project-phase.js").ProjectPhaseResult}
 */
function phaseResult(fields) {
  return /** @type {import("../src/project-phase.js").ProjectPhaseResult} */ ({
    phase: "applied",
    artifacts: [],
    managedFiles: [],
    formatterFailures: [],
    managedFilePlanProblem: null,
    wiringFindings: [],
    marker: { status: "absent" },
    records: {
      recipe: true,
      state: true,
      profile: true,
      lockEntries: 0,
      baseSkillRecorded: false,
      baseSkillPresent: false,
    },
    rollbackFiles: null,
    ...fields,
  });
}

/** @param {Record<string, unknown>} fields @param {"artifacts status" | "artifacts doctor"} [command] */
const line = (fields, command = "artifacts doctor") =>
  phaseLine(phaseResult(fields), { command, recipe, config: CONFIG });

test("each phase has the doctors' level in artifacts doctor and is a note in artifacts status", () => {
  const levels = {
    "pending-transaction": "error",
    unmanaged: "error",
    ejected: "error",
    bootstrapped: "warn",
    composed: "warn",
    applied: "info",
    drifted: "info",
    incomplete: "error",
  };
  for (const [phase, level] of Object.entries(levels)) {
    assert.equal(line({ phase }).level, level, phase);
    assert.equal(line({ phase }, "artifacts status").level, "info", phase);
    assert.equal(line({ phase }, "artifacts status").message, line({ phase }).message, phase);
  }
});

test("each phase line names its remedy with the recipe's runner and config path", () => {
  assert.equal(
    line({ phase: "unmanaged" }).message,
    `No recipe, state, or lock exists here, so Calavera does not manage this project. Pass --config <path> when the recipe is saved elsewhere, or run ${RUN} init ${FLAGS} to start.`,
  );
  assert.equal(
    line({ phase: "ejected" }).message,
    `eject removed Calavera's records from this project, so there is nothing for a doctor to check. Remove the doctor step that still runs, or run ${RUN} init ${FLAGS} to manage the project again.`,
  );
  assert.equal(
    line({ phase: "ejected", marker: { status: "edited" } }).message,
    `${line({ phase: "ejected" }).message} The ejected block in .gitignore holds lines other than its comment, and apply and eject stop on it, so move your own lines out of the block.`,
  );
  assert.equal(
    line({ phase: "bootstrapped" }).message,
    `The project is bootstrapped and has no recipe yet, so run ${RUN} init ${FLAGS}, or pass --config <path> when the recipe is saved elsewhere. If an eject stopped partway, run ${RUN} eject ${FLAGS} again.`,
  );
  assert.equal(
    line({ phase: "composed" }).message,
    `The recipe in ${CONFIG} is not applied yet, so run ${RUN} apply ${FLAGS}.`,
  );
  assert.equal(line({ phase: "applied" }).message, "The phase is applied.");
  assert.equal(
    line({ phase: "pending-transaction" }).message,
    "An artifact operation stopped before its rollback ran.",
  );
  // Without a recipe, the commands use npm, and the default config path adds no flag.
  assert.equal(
    phaseLine(phaseResult({ phase: "composed" }), {
      command: "artifacts doctor",
      recipe: undefined,
      config: "calavera.config.json",
    }).message,
    "The recipe in calavera.config.json is not applied yet, so run npm create project-calavera apply.",
  );
});

test("a drifted line names the managed files and wiring that drifted only when no selected artifact did", () => {
  const file = (/** @type {string} */ path, /** @type {string} */ name, recorded = true) => ({
    path,
    integration: "knip",
    recorded,
    condition: { name, reason: "" },
  });
  const artifact = (/** @type {boolean | null} */ selected, /** @type {string} */ name) => ({
    id: "a",
    lockEntry: null,
    selected,
    outputs: [],
    condition: { name, reason: "" },
  });
  const drifted = (/** @type {Record<string, unknown>} */ fields) =>
    line({ phase: "drifted", ...fields }).message;

  assert.equal(drifted({}), "The phase is drifted.");
  for (const name of ["missing", "unreadable", "edited"]) {
    assert.equal(
      drifted({ managedFiles: [file("knip.json", name)] }),
      "The phase is drifted. No artifact changed: the managed file knip.json did, which doctor reports.",
      name,
    );
  }
  assert.equal(
    drifted({ managedFiles: [file("a.json", "missing"), file("b.json", "edited")] }),
    "The phase is drifted. No artifact changed: the managed files a.json and b.json did, which doctor reports.",
  );
  // Files without a record, and conditions that do not drift, are not named.
  assert.equal(
    drifted({
      managedFiles: [
        file("a.json", "unreadable", false),
        file("b.json", "current"),
        file("c.json", "not-checked"),
      ],
    }),
    "The phase is drifted.",
  );
  assert.equal(
    drifted({
      managedFiles: [file("knip.json", "missing")],
      wiringFindings: [
        { artifact: "x", selected: true },
        { artifact: "x", selected: true },
        { artifact: "y", selected: false },
      ],
    }),
    "The phase is drifted. No artifact changed: the managed file knip.json and the wiring of x did, which doctor reports.",
  );
  // A selected artifact that drifted is named on its own line, so the phase line adds nothing.
  for (const name of ["missing", "unreadable", "edited", "unrecorded"]) {
    assert.equal(
      drifted({ artifacts: [artifact(true, name)], managedFiles: [file("knip.json", "missing")] }),
      "The phase is drifted.",
      name,
    );
  }
  // A deselected one, or one without a recipe, does not hide what drifted.
  for (const selected of [false, null]) {
    assert.match(
      drifted({
        artifacts: [artifact(selected, "missing")],
        managedFiles: [file("k.json", "missing")],
      }),
      /No artifact changed/,
    );
  }
  assert.match(
    drifted({ artifacts: [artifact(true, "pending")], managedFiles: [file("k.json", "missing")] }),
    /No artifact changed/,
  );
});

test("an incomplete line names the records that remain and the ones that are missing", () => {
  const records = (/** @type {Record<string, unknown>} */ fields) => ({
    recipe: false,
    state: false,
    profile: false,
    lockEntries: 0,
    baseSkillRecorded: false,
    baseSkillPresent: false,
    ...fields,
  });
  const incomplete = (/** @type {Record<string, unknown>} */ fields) =>
    line({ phase: "incomplete", records: records(fields) }).message;
  const remedy = `If the recipe is saved elsewhere, pass --config <path>; otherwise restore the missing record from version control, or run ${RUN} eject ${FLAGS} without --yes to finish removing Calavera's footprint.`;
  assert.equal(
    incomplete({ recipe: true, lockEntries: 2 }),
    `Some of Calavera's records are gone: the recipe ${CONFIG} and .calavera/artifacts.lock.json remain, but .calavera/state.json is missing. ${remedy}`,
  );
  assert.equal(
    incomplete({ state: true, profile: true }),
    `Some of Calavera's records are gone: .calavera/state.json remains, but the recipe ${CONFIG} is missing. ${remedy}`,
  );
  assert.equal(
    incomplete({ state: true, baseSkillRecorded: true }),
    `Some of Calavera's records are gone: .calavera/state.json remains, but the recipe ${CONFIG} and .agents/skills/calavera are missing. ${remedy}`,
  );
  assert.equal(
    incomplete({ state: true, lockEntries: 1, baseSkillRecorded: true, baseSkillPresent: true }),
    `Some of Calavera's records are gone: .calavera/state.json, .calavera/artifacts.lock.json, and .agents/skills/calavera remain, but the recipe ${CONFIG} is missing. ${remedy}`,
  );
});

test("the read-only report says when a managed file was not checked, and only then", () => {
  const notChecked = {
    phase: "applied",
    managedFiles: [{ path: "knip.json", recorded: true, condition: { name: "not-checked" } }],
  };
  const suffix =
    " This read-only report does not run the project's formatter, so run doctor for the condition of the managed files that need it.";
  const readOnly = (/** @type {Record<string, unknown>} */ fields) =>
    phaseLine(phaseResult(fields), {
      command: "artifacts status",
      recipe,
      config: CONFIG,
      readOnly: true,
    }).message;
  assert.equal(readOnly(notChecked), `The phase is applied.${suffix}`);
  assert.equal(readOnly({ phase: "applied" }), "The phase is applied.");
  assert.equal(
    readOnly({
      phase: "applied",
      managedFiles: [{ path: "knip.json", recorded: true, condition: { name: "current" } }],
    }),
    "The phase is applied.",
  );
  assert.equal(line(notChecked, "artifacts status").message, "The phase is applied.");
});

test("the marker notes name an edited block outside ejected, and a broken or unreadable marker", () => {
  const notes = (/** @type {Record<string, unknown>} */ fields) => phaseNotes(phaseResult(fields));
  assert.deepEqual(notes({ marker: { status: "absent" } }), []);
  assert.deepEqual(notes({ marker: { status: "complete" } }), []);
  assert.deepEqual(notes({ marker: null }), []);
  // In ejected, the phase line names the edit itself.
  assert.deepEqual(notes({ phase: "ejected", marker: { status: "edited" } }), []);
  assert.deepEqual(notes({ phase: "composed", marker: { status: "edited" } }), [
    "The ejected block in .gitignore holds lines other than its comment, so the next apply stops on it. Move your own lines out of the block.",
  ]);
  assert.deepEqual(notes({ marker: { status: "broken" } }), [
    "A marker of the ejected block in .gitignore was changed or is unpaired, so apply and eject stop on it. Restore the marker lines, or remove them.",
  ]);
  assert.deepEqual(notes({ marker: { status: "unreadable", code: "EISDIR" } }), [
    ".gitignore cannot be read (EISDIR), so Calavera cannot tell whether eject left its marker there.",
  ]);
  assert.deepEqual(notes({ marker: { status: "unreadable", code: null } }), [
    ".gitignore cannot be read (an error without a code), so Calavera cannot tell whether eject left its marker there.",
  ]);
});

/**
 * A report with every field the phase report and the verdict read.
 *
 * @param {Record<string, unknown>} fields
 */
function report(fields) {
  return /** @type {import("../src/artifact-status-report.js").ArtifactStatusReport} */ (
    /** @type {unknown} */ ({
      command: "artifacts doctor",
      ok: true,
      artifacts: [],
      phase: "applied",
      phaseLine: { level: "info", message: "The phase is applied." },
      phaseNotes: [],
      formatterFailures: [],
      managedFilePlanProblem: null,
      cacheBlockProblem: null,
      ...fields,
    })
  );
}

test("the phase report prints the line, the notes, and the managed-file check at each command's level", () => {
  const fields = {
    phaseNotes: ["note"],
    formatterFailures: [{ path: "knip.json", kind: "failed", reason: "formatter failed" }],
    managedFilePlanProblem: "plan problem",
  };
  assert.deepEqual(formatPhaseReport(report(fields)), [
    { level: "info", message: "The phase is applied." },
    { level: "info", message: "note" },
    { level: "error", message: "formatter failed" },
    { level: "error", message: "plan problem" },
  ]);
  assert.deepEqual(formatPhaseReport(report({ ...fields, command: "artifacts status" })), [
    { level: "info", message: "The phase is applied." },
    { level: "info", message: "note" },
    { level: "info", message: "formatter failed" },
    { level: "info", message: "plan problem" },
  ]);
  assert.deepEqual(
    formatPhaseReport(
      report({
        phase: "pending-transaction",
        phaseLine: { level: "error", message: "pending" },
        rollbackFiles: [".calavera/state.json", ".agents/skills/x"],
      }),
    ),
    [
      { level: "error", message: "pending" },
      { level: "info", message: "  The rollback restores or removes .calavera/state.json." },
      { level: "info", message: "  The rollback restores or removes .agents/skills/x." },
    ],
  );
  // Rollback files belong only to a pending transaction, and a null list prints none.
  assert.equal(formatPhaseReport(report({ rollbackFiles: ["x"] })).length, 1);
  assert.equal(
    formatPhaseReport(
      report({
        phase: "pending-transaction",
        phaseLine: { level: "error", message: "p" },
        rollbackFiles: null,
      }),
    ).length,
    1,
  );
});

test("the verdict names each check that failed", () => {
  const failing = {
    id: "skill-a",
    version: "1.0.0",
    selected: true,
    condition: { name: "missing", reason: "" },
    updateCheckFailure: null,
  };
  const verdict = (/** @type {Record<string, unknown>} */ fields) =>
    artifactDoctorVerdict(report({ ok: false, ...fields })).at(-1);
  assert.deepEqual(verdict({ artifacts: [failing] }), {
    level: "error",
    message: "Calavera artifacts doctor found problems with 1 artifact: skill-a.",
  });
  assert.deepEqual(
    verdict({
      phase: "incomplete",
      phaseLine: { level: "error", message: "x" },
      formatterFailures: [{ path: null, kind: "not-installed", reason: "x" }],
      managedFilePlanProblem: "x",
      artifacts: [failing, { ...failing, id: "skill-b" }],
    }),
    {
      level: "error",
      message:
        "Calavera artifacts doctor found problems with the project phase, incomplete, the managed-file check, whose formatter failed, the managed-file check, which could not plan the managed files, and 2 artifacts: skill-a, skill-b.",
    },
  );
  assert.deepEqual(verdict({ phase: "unmanaged", phaseLine: { level: "error", message: "x" } }), {
    level: "error",
    message: "Calavera artifacts doctor found problems with the project phase, unmanaged.",
  });
  // A warning phase line is not a failed check.
  assert.deepEqual(
    verdict({
      phase: "composed",
      phaseLine: { level: "warn", message: "x" },
      managedFilePlanProblem: "x",
    }),
    {
      level: "error",
      message:
        "Calavera artifacts doctor found problems with the managed-file check, which could not plan the managed files.",
    },
  );
});

test("a pending transaction prints no artifact lines, only its phase report", () => {
  assert.deepEqual(
    formatArtifactStatus(
      report({ phase: "pending-transaction", phaseLine: { level: "error", message: "p" } }),
    ),
    [],
  );
});

test("an installed selection without a lock entry keeps its state on a failed update check", () => {
  const lines = formatArtifactStatus(
    report({
      offline: false,
      updateAllCommand: null,
      updateAllBlockedBy: [],
      artifacts: [
        {
          id: "skill-a",
          version: null,
          tag: "latest",
          installed: true,
          managed: true,
          locallyEdited: false,
          selected: true,
          installCommand: "install",
          condition: { name: "pending", reason: "recorded but not locked" },
          updateCheckFailure: {
            code: "ETARGET",
            reason: "no tag",
            remedy: null,
            npmDiagnostics: [],
            unsetVariables: [],
          },
        },
      ],
    }),
  );
  assert.deepEqual(lines[0], {
    level: "warn",
    message: "skill-a  installed, no lock entry, update check failed (latest)",
  });
  assert.ok(lines.some(({ message }) => message === "  recorded but not locked"));
});

test("the phase report prints a cache block problem at each command's level", () => {
  assert.deepEqual(formatPhaseReport(report({ cacheBlockProblem: "no block" })).at(-1), {
    level: "error",
    message: "no block",
  });
  assert.deepEqual(
    formatPhaseReport(report({ command: "artifacts status", cacheBlockProblem: "no block" })).at(
      -1,
    ),
    { level: "info", message: "no block" },
  );
  assert.equal(formatPhaseReport(report({})).length, 1);
});
