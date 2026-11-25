// @ts-check
import { phaseLine, phaseNotes } from "./phase-lines.js";
import { artifactCommand, calaveraCommand } from "./project-local-commands.js";

/**
 * @typedef {import("./project-phase.js").ProjectPhaseResult} ProjectPhaseResult
 *
 * @typedef {"phase" | "project" | "recipe" | "repository-root" | "managed-file" | "managed-file-check" | "artifact" | "wiring" | "marker" | "records"} DoctorCheck
 *   The check an issue comes from (ADR-0020, Decision 5). `managed-file` is each managed file's
 *   condition, which only doctor reports; `managed-file-check` is the formatter failures and the
 *   plan problem of the managed-file classification, which artifacts doctor reports too.
 *
 * @typedef {{ level: "error" | "warning" | "info", message: string, check: DoctorCheck }} DoctorIssue
 */

/** The doctors' phase line levels in doctor's words. */
const LEVELS = /** @type {const} */ ({ error: "error", warn: "warning", info: "info" });

const PROBLEMS = new Set(["missing", "unreadable", "edited", "unrecorded"]);

/**
 * The issues doctor reports from the phase function's result (ADR-0020, Decision 4): the phase
 * line first, then the marker notes, each managed file's condition, the managed-file check's
 * formatter failures and plan problem, and each artifact's condition at the levels #994 set.
 * During a pending transaction only the phase line is reported, because the records can still
 * change (owner decision 20).
 *
 * @param {ProjectPhaseResult} result
 * @param {{ recipe: unknown, config: string, pendingMessage?: string }} options `pendingMessage`
 *   is the phase line during a pending transaction, which names the remedy.
 * @returns {{ phaseLine: { level: DoctorIssue["level"], message: string }, issues: DoctorIssue[] }}
 */
export function phaseIssues(result, { recipe, config, pendingMessage }) {
  const line = phaseLine(result, { command: "artifacts doctor", recipe, config });
  const level = LEVELS[line.level];
  const message =
    result.phase === "pending-transaction" && pendingMessage ? pendingMessage : line.message;
  /** @type {DoctorIssue[]} */
  const issues = [{ level, message, check: "phase" }];
  if (result.phase === "pending-transaction") {
    return { phaseLine: { level, message }, issues };
  }
  const apply = calaveraCommand(recipe, config, ["apply"]);
  for (const note of phaseNotes(result)) {
    issues.push({ level: "info", message: note, check: "marker" });
  }
  for (const file of result.managedFiles) {
    const issue = managedFileIssue(file, apply);
    if (issue) issues.push(issue);
  }
  for (const { reason } of result.formatterFailures) {
    issues.push({ level: "error", message: reason, check: "managed-file-check" });
  }
  if (result.managedFilePlanProblem !== null) {
    issues.push({
      level: "error",
      message: result.managedFilePlanProblem,
      check: "managed-file-check",
    });
  }
  const install = artifactCommand(recipe, config, ["install"]);
  for (const artifact of result.artifacts) {
    const issue = artifactIssue(artifact, install);
    if (issue) issues.push(issue);
  }
  return { phaseLine: { level, message }, issues };
}

/**
 * A managed file's condition as doctor reports it (ADR-0020, Decision 4, and the owner decisions
 * of 2026-11-25): pending is a warning and missing or unreadable an error, each with the apply
 * command; edited and unrecorded are notes whose remedies keep the person's file first. A file
 * that is current gets no line, and neither does one that is `not-checked`, because the formatter
 * failure names it.
 *
 * @param {import("./phase-managed-files.js").ClassifiedManagedFile} file
 * @param {string} apply
 * @returns {DoctorIssue | undefined}
 */
function managedFileIssue({ path, condition }, apply) {
  const { name, reason } = condition;
  /** @type {(level: DoctorIssue["level"], message: string) => DoctorIssue} */
  const issue = (level, message) => ({ level, message, check: "managed-file" });
  // A root-only integration's file in a workspace member is classified at the repository root, so
  // its apply runs there (#925).
  const where = path.startsWith("../") ? " from the repository root" : "";
  if (name === "pending") return issue("warning", `${reason} Run ${apply}${where}.`);
  if (name === "missing") return issue("error", `${reason} Run ${apply}${where}.`);
  if (name === "unreadable") {
    return issue("error", `${reason} apply stops on it too, so make it a readable file.`);
  }
  if (name === "edited") {
    return issue(
      "info",
      `${reason} To keep the edit, save a copy of the file first, migrate the edit into the project's own configuration, or deselect the integration, so that clean keeps the edited file and reports it. To discard it, restore the contents Calavera recorded, remove the file so that ${apply} writes it again, or pass --reown-managed-file, which accepts that apply replaces the edit with Calavera's contents.`,
    );
  }
  if (name === "unrecorded") {
    return issue(
      "info",
      `${reason} To keep your file, rename or move it, deselect the integration, or migrate its settings into the project's own configuration.`,
    );
  }
  return undefined;
}

/**
 * An artifact's condition as doctor reports it, at the levels #994 set for artifacts doctor, so
 * the two doctors agree (ADR-0020, Decision 5): a selected artifact with a problem is an error and
 * a pending one a note; a deselected entry with a problem is a warning (#1111, owner decision 6),
 * with the install command that drops it when its files are missing; a current artifact gets no
 * line. Without a recipe, an artifact's line has no level of its own, so it is a note.
 *
 * @param {import("./project-phase.js").ClassifiedArtifact} artifact
 * @param {string} install
 * @returns {DoctorIssue | undefined}
 */
function artifactIssue({ selected, condition }, install) {
  const { name, reason } = condition;
  /** @type {(level: DoctorIssue["level"], message: string) => DoctorIssue} */
  const issue = (level, message) => ({ level, message, check: "artifact" });
  if (name === "current") return undefined;
  if (selected === true) return issue(PROBLEMS.has(name) ? "error" : "info", reason);
  if (selected === false) {
    return name === "missing"
      ? issue("warning", `${reason} Run ${install}.`)
      : issue("warning", reason);
  }
  return issue("info", reason);
}

/**
 * The heading each check's issues are printed under, in the order the groups print, so every
 * managed file and artifact is named once, under a heading, as the release's listing check
 * requires (`listingViolations` in `scripts/rehearsal-checks.mjs`). The names match the apply
 * summary's groups, and "Artifacts:" is the heading #1315 gives the artifact commands.
 *
 * @type {[string, DoctorCheck[]][]}
 */
const GROUPS = [
  ["Project:", ["project", "repository-root", "marker"]],
  ["Recipe:", ["recipe"]],
  ["Managed files:", ["managed-file", "managed-file-check"]],
  ["Artifacts:", ["artifact"]],
  ["Wiring:", ["wiring"]],
  ["Records:", ["records"]],
];

/**
 * The labels of the checks the verdict names, and whether artifacts doctor makes the check too.
 *
 * @type {Record<DoctorCheck, { label: string, shared: boolean }>}
 */
const CHECKS = {
  phase: { label: "the project phase", shared: true },
  project: { label: "the project", shared: false },
  recipe: { label: "the recipe", shared: false },
  "repository-root": { label: "the repository-root refusals", shared: false },
  "managed-file": { label: "a managed file's condition", shared: false },
  "managed-file-check": { label: "the managed-file check", shared: true },
  artifact: { label: "an artifact's condition", shared: true },
  wiring: { label: "the recorded wiring", shared: false },
  marker: { label: "the eject marker", shared: false },
  records: { label: "a record Calavera cannot read", shared: true },
};

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The lines doctor's text output prints: the phase line first, then, during a pending
 * transaction, each file the rollback would restore or remove, then each group under its heading,
 * and last the verdict, which names each check that failed and says which of them artifacts
 * doctor does not make (ADR-0020, Decision 5).
 *
 * @param {{ ok: boolean, issues: DoctorIssue[], rollbackFiles?: string[] | null }} result
 * @returns {{ level: "error" | "warn" | "info" | "success", message: string }[]}
 */
export function doctorReportLines(result) {
  /** @type {{ level: "error" | "warn" | "info" | "success", message: string }[]} */
  const lines = [];
  /** @param {DoctorIssue["level"]} level */
  const logLevel = (level) => (level === "warning" ? "warn" : level);
  const [first, ...rest] = result.issues;
  const phase = first?.check === "phase" ? first : undefined;
  const items = phase ? rest : result.issues;
  if (phase) lines.push({ level: logLevel(phase.level), message: phase.message });
  for (const path of result.rollbackFiles ?? []) {
    lines.push({ level: "info", message: `  The rollback restores or removes ${path}.` });
  }
  for (const [heading, checks] of GROUPS) {
    const group = items.filter(({ check }) => checks.includes(check));
    if (group.length === 0) continue;
    lines.push({ level: "info", message: heading });
    for (const { level, message } of group) {
      lines.push({ level: logLevel(level), message: `  ${message}` });
    }
  }
  const errors = result.issues.filter(({ level }) => level === "error");
  if (errors.length === 0) {
    // ADR-0020, Decision 4: the success line follows the phase line when nothing else is reported.
    if (items.length === 0 && phase?.level === "info") {
      lines.push({ level: "success", message: "Calavera doctor found no issues." });
    }
    return lines;
  }
  const failed = [...new Set(errors.map(({ check }) => check))];
  const shared = failed.filter((check) => CHECKS[check].shared).map((check) => CHECKS[check].label);
  const only = failed.filter((check) => !CHECKS[check].shared).map((check) => CHECKS[check].label);
  const parts = [
    ...shared,
    ...(only.length > 0 ? [`${LIST.format(only)}, which artifacts doctor does not report`] : []),
  ];
  lines.push({
    level: "error",
    message: `Calavera doctor found ${errors.length} ${errors.length === 1 ? "error" : "errors"}: ${LIST.format(parts)}.`,
  });
  return lines;
}
