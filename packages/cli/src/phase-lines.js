// @ts-check
import { GITIGNORE_PATH } from "./ignore-lines.js";
import { LOCK_PATH, PACKAGE_PATH, STATE_PATH } from "./artifact-lifecycle.js";
import { BASE_SKILL_PATH } from "./ai/artifacts.js";
import { calaveraCommand } from "./project-local-commands.js";

/**
 * @typedef {import("./project-phase.js").ProjectPhaseResult} ProjectPhaseResult
 * @typedef {"info" | "warn" | "error"} PhaseLineLevel
 * @typedef {{ level: PhaseLineLevel, message: string }} PhaseLine
 */

/**
 * The level of the phase line in each doctor (ADR-0020, Decision 4). `artifacts status` prints the
 * same line as a note, whatever the phase.
 *
 * @type {Record<import("./project-phase.js").ProjectPhase, PhaseLineLevel>}
 */
const DOCTOR_LEVELS = {
  "pending-transaction": "error",
  unmanaged: "error",
  ejected: "error",
  bootstrapped: "warn",
  composed: "warn",
  applied: "info",
  drifted: "info",
  incomplete: "error",
};

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The line every artifact command's report starts with, which names the project's phase and what
 * resolves it (ADR-0020, Decision 4). Its level is the doctors' level, except in
 * `artifacts status`, where every phase line is a note. It names paths, IDs, and commands only.
 *
 * @param {ProjectPhaseResult} result
 * @param {object} options
 * @param {"artifacts status" | "artifacts doctor"} options.command
 * @param {unknown} options.recipe The parsed recipe, or undefined, for the runner commands name.
 * @param {string} options.config
 * @param {boolean} [options.readOnly] The read-only status tool, which never runs the formatter.
 * @param {boolean} [options.forDoctor] For `doctor`, which names the recipe path in its recipe
 *   group's heading and each drifted item under its own heading, so its phase line names neither
 *   (ADR-0020, Decision 4 and Amendment 2).
 * @returns {PhaseLine}
 */
export function phaseLine(
  result,
  { command, recipe, config, readOnly = false, forDoctor = false },
) {
  const level = command === "artifacts doctor" ? DOCTOR_LEVELS[result.phase] : "info";
  /** @param {...string} positionals */
  const run = (...positionals) => calaveraCommand(recipe, config, positionals);
  const elsewhere = "pass --config <path> when the recipe is saved elsewhere";
  /** @type {Record<import("./project-phase.js").ProjectPhase, () => string>} */
  const messages = {
    // The pending-transaction report gives its own line, with the files and the remedy.
    "pending-transaction": () => "An artifact operation stopped before its rollback ran.",
    unmanaged: () =>
      `No recipe, state, or lock exists here, so Calavera does not manage this project. ${capitalize(elsewhere)}, or run ${run("init")} to start.`,
    ejected: () =>
      `eject removed Calavera's records from this project, so there is nothing for a doctor to check. Remove the doctor step that still runs, or run ${run("init")} to manage the project again.${
        result.marker?.status === "edited"
          ? ` The ejected block in ${GITIGNORE_PATH} holds lines other than its comment, and apply and eject stop on it, so move your own lines out of the block.`
          : ""
      }`,
    bootstrapped: () =>
      `The project is bootstrapped and has no recipe yet, so run ${run("init")}, or ${elsewhere}. If an eject stopped partway, run ${run("eject")} again.`,
    composed: () =>
      `The recipe${forDoctor ? "" : ` in ${config}`} is not applied yet, so run ${run("apply")}.`,
    applied: () => "The phase is applied.",
    drifted: () => `The phase is drifted.${forDoctor ? "" : driftedElsewhere(result)}`,
    incomplete: () => incompleteMessage(result, run, forDoctor ? undefined : config),
  };
  const notChecked =
    readOnly && result.managedFiles.some(({ condition }) => condition.name === "not-checked")
      ? " This read-only report does not run the project's formatter, so run doctor for the condition of the managed files that need it."
      : "";
  return { level, message: `${messages[result.phase]()}${notChecked}` };
}

/**
 * The notes about the `ejected` marker in a phase where records exist and the marker is otherwise
 * ignored (ADR-0020, Decision 2, owner decision 25): an edited block, or a broken or unreadable
 * marker, which `apply` and `eject` stop on. In `ejected`, the phase line names an edited block
 * itself.
 *
 * @param {ProjectPhaseResult} result
 * @returns {string[]}
 */
export function phaseNotes(result) {
  const marker = result.marker;
  if (!marker || marker.status === "absent" || marker.status === "complete") return [];
  if (marker.status === "edited") {
    return result.phase === "ejected"
      ? []
      : [
          `The ejected block in ${GITIGNORE_PATH} holds lines other than its comment, so the next apply stops on it. Move your own lines out of the block.`,
        ];
  }
  if (marker.status === "broken") {
    return [
      `A marker of the ejected block in ${GITIGNORE_PATH} was changed or is unpaired, so apply and eject stop on it. Restore the marker lines, or remove them.`,
    ];
  }
  const code = "code" in marker ? marker.code : null;
  return [
    `${GITIGNORE_PATH} cannot be read (${code ?? "an error without a code"}), so Calavera cannot tell whether eject left its marker there.`,
  ];
}

/**
 * When no selected artifact drifted, what did: a managed file or a selected artifact's wiring,
 * which `doctor` reports (ADR-0020, Decision 4).
 *
 * @param {ProjectPhaseResult} result
 */
function driftedElsewhere(result) {
  const artifactDrifted = result.artifacts.some(
    ({ selected, condition }) =>
      selected === true &&
      ["missing", "unreadable", "edited", "unrecorded"].includes(condition.name),
  );
  if (artifactDrifted) return "";
  const files = result.managedFiles
    .filter(
      ({ recorded, condition }) =>
        recorded && ["missing", "unreadable", "edited"].includes(condition.name),
    )
    .map(({ path }) => path);
  const wiring = [
    ...new Set(
      result.wiringFindings.filter(({ selected }) => selected).map(({ artifact }) => artifact),
    ),
  ];
  const parts = [
    ...(files.length > 0
      ? [`the managed ${files.length === 1 ? "file" : "files"} ${LIST.format(files)}`]
      : []),
    ...(wiring.length > 0 ? [`the wiring of ${LIST.format(wiring)}`] : []),
  ];
  return parts.length === 0
    ? ""
    : ` No artifact changed: ${LIST.format(parts)} did, which doctor reports.`;
}

/**
 * The `incomplete` line, which names the records that remain and the ones that are missing, and
 * the remedies that fit (ADR-0020, Decision 4, owner decisions 9 and 18).
 *
 * @param {ProjectPhaseResult} result
 * @param {(...positionals: string[]) => string} run
 * @param {string | undefined} config The recipe path, or undefined to say "the recipe".
 */
function incompleteMessage(result, run, config) {
  const records = /** @type {NonNullable<ProjectPhaseResult["records"]>} */ (result.records);
  const remain = [
    ...(records.recipe ? [config ? `the recipe ${config}` : "the recipe"] : []),
    ...(records.state ? [STATE_PATH] : []),
    ...(records.lockEntries > 0 ? [LOCK_PATH] : []),
    ...(records.packagesPresent ? [PACKAGE_PATH] : []),
    ...(records.baseSkillPresent ? [BASE_SKILL_PATH] : []),
  ];
  const missing = [
    ...(records.recipe ? [] : [config ? `the recipe ${config}` : "the recipe"]),
    ...(records.state ? [] : [STATE_PATH]),
    ...(records.baseSkillRecorded && !records.baseSkillPresent ? [BASE_SKILL_PATH] : []),
  ];
  const remainText =
    remain.length > 0 ? `${LIST.format(remain)} ${remain.length === 1 ? "remains" : "remain"}` : "";
  const missingText =
    missing.length > 0
      ? `${LIST.format(missing)} ${missing.length === 1 ? "is" : "are"} missing`
      : "";
  const found = [remainText, missingText].filter(Boolean).join(", but ");
  return `Some of Calavera's records are gone: ${found}. If the recipe is saved elsewhere, pass --config <path>; otherwise restore the missing record from version control, or run ${run("eject")} without --yes to finish removing Calavera's footprint.`;
}

/** @param {string} text */
function capitalize(text) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
