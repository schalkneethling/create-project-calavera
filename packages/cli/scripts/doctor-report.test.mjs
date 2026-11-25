// #1112 (ADR-0020, Decisions 4 and 5, Amendment 2): the issues doctor builds from the phase
// function's result, and its text output, built here from hand-made results so each rule of the
// wording, the levels, the groups, and the verdict has a test.
import assert from "node:assert/strict";
import test from "node:test";

import { doctorReportLines, phaseIssues } from "../src/doctor-report.js";

const recipe = { packageManager: "pnpm" };
const APPLY = "pnpm dlx create-project-calavera apply";
const INSTALL = "pnpm dlx create-project-calavera artifacts install";

/**
 * A phase function result with every field, overridden by `fields`.
 *
 * @param {Record<string, unknown>} fields
 * @returns {import("../src/project-phase.js").ProjectPhaseResult}
 */
function phase(fields) {
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
      packagesPresent: false,
    },
    rollbackFiles: null,
    ...fields,
  });
}

/** @param {Record<string, unknown>} fields @param {string} [repositoryRoot] */
const issues = (fields, repositoryRoot) =>
  phaseIssues(phase(fields), { recipe, config: "calavera.config.json", repositoryRoot }).issues;

/** @param {string} path @param {string} name */
const file = (path, name) => ({
  path,
  integration: "knip",
  recorded: true,
  condition: { name, reason: `${path} reason.` },
});

/** @param {boolean | null} selected @param {string} name */
const artifact = (selected, name) => ({
  id: "skill-a",
  lockEntry: null,
  selected,
  outputs: [],
  condition: { name, reason: "skill-a reason." },
});

test("the phase line comes first, at the doctors' level in doctor's words", () => {
  // The recipe heading names the path, so doctor's phase line says "the recipe".
  assert.deepEqual(issues({ phase: "composed" })[0], {
    level: "warning",
    check: "phase",
    message: "The recipe is not applied yet, so run pnpm dlx create-project-calavera apply.",
  });
  assert.equal(issues({ phase: "unmanaged" })[0]?.level, "error");
  assert.equal(issues({ phase: "applied" })[0]?.level, "info");
});

test("a pending transaction reports the remedy as its phase line and nothing else", () => {
  const result = phaseIssues(
    phase({
      phase: "pending-transaction",
      managedFiles: [file("knip.json", "missing")],
      artifacts: [artifact(true, "missing")],
      marker: { status: "edited" },
    }),
    { recipe, config: "calavera.config.json", pendingMessage: "Save your edits, then run status." },
  );
  assert.deepEqual(result.issues, [
    { level: "error", check: "phase", message: "Save your edits, then run status." },
  ]);
  assert.deepEqual(result.phaseLine, {
    level: "error",
    message: "Save your edits, then run status.",
  });
});

test("each managed file condition has its level and remedy", () => {
  const rest = (
    /** @type {string} */ name,
    path = "knip.json",
    /** @type {string | undefined} */ root = undefined,
  ) => issues({ managedFiles: [file(path, name)] }, root).slice(1);
  assert.deepEqual(rest("pending"), [
    { level: "warning", check: "managed-file", message: `knip.json reason. Run ${APPLY}.` },
  ]);
  assert.deepEqual(rest("missing"), [
    { level: "error", check: "managed-file", message: `knip.json reason. Run ${APPLY}.` },
  ]);
  // A root-only file, seen from a workspace member, names the root and leaves --config to the
  // person, because the member's recipe path does not hold there.
  assert.deepEqual(rest("missing", "../../knip.json", "/work/repo"), [
    {
      level: "error",
      check: "managed-file",
      message: `../../knip.json reason. Run ${APPLY} from the repository root, /work/repo, adding --config <path> when the recipe is saved elsewhere.`,
    },
  ]);
  // Only a path outside the project, with the root known, gets the root remedy.
  assert.equal(
    rest("missing", "../../knip.json")[0]?.message,
    `../../knip.json reason. Run ${APPLY}.`,
  );
  assert.equal(
    rest("missing", "knip.json", "/work/repo")[0]?.message,
    `knip.json reason. Run ${APPLY}.`,
  );
  assert.deepEqual(rest("unreadable"), [
    {
      level: "error",
      check: "managed-file",
      message: "knip.json reason. apply stops on it too, so make it a readable file.",
    },
  ]);
  assert.deepEqual(rest("edited"), [
    {
      level: "info",
      check: "managed-file",
      message: `knip.json reason. To keep the edit, save a copy of the file first, migrate the edit into the project's own configuration, or deselect the integration, so that clean keeps the edited file and reports it. To discard it, restore the contents Calavera recorded, remove the file so that ${APPLY} writes it again, or pass --reown-managed-file, which accepts that apply replaces the edit with Calavera's contents.`,
    },
  ]);
  assert.deepEqual(rest("unrecorded"), [
    {
      level: "info",
      check: "managed-file",
      message:
        "knip.json reason. To keep your file, rename or move it, deselect the integration, or migrate its settings into the project's own configuration.",
    },
  ]);
  for (const name of ["current", "not-checked"]) assert.deepEqual(rest(name), [], name);
});

test("formatter failures and the plan problem are errors on the managed-file check", () => {
  assert.deepEqual(
    issues({
      formatterFailures: [{ path: "knip.json", kind: "failed", reason: "formatter failed" }],
      managedFilePlanProblem: "no plan",
    }).slice(1),
    [
      { level: "error", check: "managed-file-check", message: "formatter failed" },
      { level: "error", check: "managed-file-check", message: "no plan" },
    ],
  );
});

test("each artifact condition has the level #994 set, and the marker notes come first", () => {
  const rest = (/** @type {boolean | null} */ selected, /** @type {string} */ name) =>
    issues({ artifacts: [artifact(selected, name)] }).slice(1);
  for (const name of ["missing", "unreadable", "edited", "unrecorded"]) {
    assert.deepEqual(
      rest(true, name),
      [{ level: "error", check: "artifact", artifact: "skill-a", message: "skill-a reason." }],
      name,
    );
    assert.equal(rest(false, name)[0]?.level, "warning", name);
    assert.equal(rest(null, name)[0]?.level, "info", name);
  }
  assert.deepEqual(rest(true, "pending"), [
    { level: "info", check: "artifact", artifact: "skill-a", message: "skill-a reason." },
  ]);
  // A deselected entry whose files are missing names the command that drops its lock entry.
  assert.deepEqual(rest(false, "missing"), [
    {
      level: "warning",
      check: "artifact",
      artifact: "skill-a",
      message: `skill-a reason. Run ${INSTALL}.`,
    },
  ]);
  assert.deepEqual(rest(false, "edited"), [
    { level: "warning", check: "artifact", artifact: "skill-a", message: "skill-a reason." },
  ]);
  // As artifacts doctor does (owner decision 6), a deselected entry without a problem is silent.
  assert.deepEqual(rest(false, "pending"), []);
  for (const selected of [true, false, null]) assert.deepEqual(rest(selected, "current"), []);
  assert.deepEqual(
    issues({ phase: "composed", marker: { status: "broken" } })
      .slice(1)
      .map(({ check, level }) => [check, level]),
    [["marker", "info"]],
  );
});

/**
 * @param {import("../src/doctor-report.js").DoctorIssue[]} list
 * @param {string[] | null} [rollbackFiles]
 * @param {string} [config]
 */
const lines = (list, rollbackFiles, config) =>
  doctorReportLines({
    ok: !list.some(({ level }) => level === "error"),
    issues: list,
    rollbackFiles,
    config,
  });

test("the text output groups each check under its heading, in a fixed order", () => {
  assert.deepEqual(
    lines([
      { level: "info", check: "phase", message: "The phase is drifted." },
      { level: "warning", check: "wiring", message: "skill-a w", artifact: "skill-a", detail: "w" },
      { level: "warning", check: "artifact", message: "a", artifact: "skill-a" },
      { level: "warning", check: "managed-file", message: "m" },
      { level: "info", check: "managed-file-check", message: "c" },
      { level: "warning", check: "recipe", message: "r" },
      { level: "warning", check: "project", message: "p" },
      { level: "warning", check: "repository-root", message: "root" },
      { level: "info", check: "marker", message: "mark" },
    ]),
    [
      { level: "info", message: "The phase is drifted." },
      { level: "info", message: "Project:" },
      { level: "warn", message: "  p" },
      { level: "warn", message: "  root" },
      { level: "info", message: "  mark" },
      { level: "info", message: "Recipe:" },
      { level: "warn", message: "  r" },
      { level: "info", message: "Managed files:" },
      { level: "warn", message: "  m" },
      { level: "info", message: "  c" },
      { level: "info", message: "Artifacts:" },
      // The wiring finding prints under its artifact's line, without the artifact's ID.
      { level: "warn", message: "  a" },
      { level: "warn", message: "    w" },
    ],
  );
});

test("the recipe heading names the recipe path, and wiring without an artifact line names the artifact once", () => {
  assert.deepEqual(
    lines(
      [
        { level: "info", check: "phase", message: "The phase is drifted." },
        { level: "warning", check: "recipe", message: "r" },
        { level: "error", check: "wiring", message: "x w1", artifact: "skill-x", detail: "w1" },
        { level: "warning", check: "wiring", message: "x w2", artifact: "skill-x", detail: "w2" },
      ],
      undefined,
      "config/recipe.json",
    ).slice(0, 7),
    [
      { level: "info", message: "The phase is drifted." },
      { level: "info", message: "Recipe config/recipe.json:" },
      { level: "warn", message: "  r" },
      { level: "info", message: "Artifacts:" },
      {
        level: "info",
        message: "  skill-x: Calavera found a problem with the wiring apply recorded for it.",
      },
      { level: "error", message: "    w1" },
      { level: "warn", message: "    w2" },
    ],
  );
});

test("the success line follows an info phase line only when nothing else is reported", () => {
  const applied = {
    level: /** @type {const} */ ("info"),
    check: /** @type {const} */ ("phase"),
    message: "The phase is applied.",
  };
  assert.deepEqual(lines([applied]), [
    { level: "info", message: "The phase is applied." },
    { level: "success", message: "Calavera doctor found no issues." },
  ]);
  // A note is something else reported, so no success line follows it.
  assert.deepEqual(lines([applied, { level: "info", check: "artifact", message: "a" }]).at(-1), {
    level: "info",
    message: "  a",
  });
  assert.deepEqual(lines([{ level: "warning", check: "phase", message: "Not applied yet." }]), [
    { level: "warn", message: "Not applied yet." },
  ]);
});

test("an empty result prints nothing", () => {
  assert.deepEqual(lines([]), []);
});

test("the rollback's files follow the phase line", () => {
  assert.deepEqual(
    lines([{ level: "error", check: "phase", message: "pending" }], [".agents/skills/x"]).slice(
      0,
      2,
    ),
    [
      { level: "error", message: "pending" },
      { level: "info", message: "  The rollback restores or removes .agents/skills/x." },
    ],
  );
});

test("the verdict counts the errors and names the checks artifacts doctor does not make", () => {
  const verdict = (/** @type {Parameters<typeof lines>[0]} */ list) => lines(list).at(-1);
  assert.deepEqual(
    verdict([
      { level: "info", check: "phase", message: "The phase is drifted." },
      { level: "error", check: "artifact", message: "a" },
      { level: "error", check: "managed-file", message: "m" },
      { level: "error", check: "managed-file", message: "m2" },
    ]),
    {
      level: "error",
      message:
        "Calavera doctor found 3 errors: an artifact's condition and a managed file's condition. artifacts doctor does not report a managed file's condition.",
    },
  );
  assert.deepEqual(verdict([{ level: "error", check: "phase", message: "x" }]), {
    level: "error",
    message: "Calavera doctor found 1 error: the project phase.",
  });
  assert.deepEqual(
    verdict([
      { level: "error", check: "recipe", message: "r" },
      { level: "error", check: "wiring", message: "w" },
      { level: "error", check: "repository-root", message: "x" },
      { level: "error", check: "project", message: "p" },
      { level: "error", check: "marker", message: "k" },
    ]),
    {
      level: "error",
      message:
        "Calavera doctor found 5 errors: the recipe, the recorded wiring, the repository-root refusals, the project, and the eject marker. artifacts doctor does not report the recipe, the recorded wiring, the repository-root refusals, the project, or the eject marker.",
    },
  );
  assert.deepEqual(
    verdict([
      { level: "error", check: "records", message: "r" },
      { level: "error", check: "managed-file-check", message: "c" },
    ]),
    {
      level: "error",
      message:
        "Calavera doctor found 2 errors: a record Calavera cannot read and the managed-file check.",
    },
  );
});

test("the pending message replaces the phase line only during a pending transaction", () => {
  assert.equal(
    phaseIssues(phase({ phase: "pending-transaction" }), { recipe, config: "calavera.config.json" })
      .phaseLine.message,
    "An artifact operation stopped before its rollback ran.",
  );
  assert.equal(
    phaseIssues(phase({ phase: "applied" }), {
      recipe,
      config: "calavera.config.json",
      pendingMessage: "ignored",
    }).phaseLine.message,
    "The phase is applied.",
  );
});

test("a run that stopped before it classified prints its issues under their headings and the verdict", () => {
  assert.deepEqual(
    lines([
      { level: "warning", check: "project", message: "Missing package.json." },
      { level: "error", check: "records", message: "Invalid artifact lockfile." },
    ]),
    [
      { level: "info", message: "Project:" },
      { level: "warn", message: "  Missing package.json." },
      { level: "info", message: "Records:" },
      { level: "error", message: "  Invalid artifact lockfile." },
      { level: "error", message: "Calavera doctor found 1 error: a record Calavera cannot read." },
    ],
  );
});

test("an artifact error alone is a check both doctors make", () => {
  assert.deepEqual(lines([{ level: "error", check: "artifact", message: "a" }]).at(-1), {
    level: "error",
    message: "Calavera doctor found 1 error: an artifact's condition.",
  });
});
