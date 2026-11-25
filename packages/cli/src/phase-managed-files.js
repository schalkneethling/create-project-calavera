// @ts-check
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { resolveIntegrationInputs } from "./integration-inputs.js";
import {
  managedFileDifference,
  managedFileFormatterLoader,
  plannedManagedFiles,
} from "./managed-file-plans.js";
import { declaredManagedFiles } from "./project-inspection.js";
import { normalizeIntegrationOptions, resolveRecipeIntegrations } from "./recipe.js";
import { findRepositoryRoot } from "./repository-root.js";
import { managedFileStateForPath } from "./state.js";
import { fileExists } from "./utils/fs.js";
import { FormatterFailure } from "./utils/formatter-failure.js";
import { formatGeneratedText } from "./utils/generated-text.js";
import { textHash } from "./utils/hash.js";
import { detectVitePlus, vitePlusInstallDirectory } from "./vite-plus-detection.js";

/**
 * @typedef {import("./state.js").CalaveraState} CalaveraState
 * @typedef {import("./utils/formatter-failure.js").FormatterFailureKind} FormatterFailureKind
 *
 * @typedef {"pending" | "current" | "missing" | "unreadable" | "edited" | "unrecorded" | "not-checked"} ManagedFileConditionName
 *
 * @typedef {object} ClassifiedManagedFile
 * @property {string} path The file's path from the current folder; a root-only integration's file
 *   in a workspace member is at the repository root.
 * @property {string} integration The integration that declares the file.
 * @property {boolean} recorded The state holds a record for the file.
 * @property {{ name: ManagedFileConditionName, reason: string }} condition
 *
 * @typedef {object} FormatterFailureFinding
 * @property {string | null} path The file the formatter refused, or null when it could not load.
 * @property {FormatterFailureKind | null} kind Null for an error that is not a formatter failure.
 * @property {string} reason Names the file, the kind of failure, and its remedy, and quotes no file
 *   text and no tool output.
 *
 * @typedef {object} ManagedFileClassification
 * @property {ClassifiedManagedFile[]} managedFiles
 * @property {FormatterFailureFinding[]} formatterFailures
 * @property {string | null} planProblem Why the managed files could not be planned, or null.
 */

/** The managed-file conditions that make a project `drifted` after `apply`. */
export const DRIFTED_FILE_CONDITIONS = new Set(["missing", "unreadable", "edited"]);

/**
 * Classifies every managed file the recipe declares by the rule apply uses (ADR-0020, Decision 3):
 * apply's planner, the project's formatter loaded as apply loads it, and the comparison that
 * decides whether apply stops on an existing file. The formatter loads on every run with a recipe,
 * because apply loads it even when no managed file needs it (#838). A formatter that cannot load,
 * or that refuses a file, is a finding, not a stop (Decision 3, "When the formatter cannot load or
 * refuses a file"): the files it was needed for are `not-checked`, and every other file is still
 * classified. Every plan is formatted, as apply formats every file before it writes any, so a
 * refusal apply would stop on is found even for a file that needs no comparison, and the plans are
 * formatted together, as apply formats them. A recipe whose managed files cannot be planned, such
 * as one with an invalid integration option, gives a plan problem and no managed files, and the
 * phase is still derived from the other records.
 *
 * Calavera's own code writes nothing and contacts no registry: the formatter runs the project's
 * `vp fmt --stdin-filepath`, which prints the formatted text and writes no file
 * (`utils/project-formatter.js`), and integration inputs run only local Git commands to suggest a
 * default. `vp fmt` loads the project's own `vite.config.ts`, which Calavera does not control, as
 * apply does.
 *
 * @param {{ config: string, recipe: Record<string, unknown>, state: CalaveraState }} options
 * @returns {Promise<ManagedFileClassification>}
 */
export async function classifyManagedFiles({ config, recipe, state }) {
  /** @type {FormatterFailureFinding[]} */
  const formatterFailures = [];
  const integrations = resolveRecipeIntegrations(recipe);
  const projectDirectory = process.cwd();

  let detection;
  let plans;
  let repositoryRoot = projectDirectory;
  try {
    detection = await detectVitePlus(projectDirectory);
    const integrationIds = integrations.map(({ id }) => id);
    // A run that cannot prompt uses each input's default, as the dry run does. The options are
    // then checked as recipe validation checks them, so an invalid option is a plan problem.
    const { recipe: withInputs } = await resolveIntegrationInputs(recipe);
    plans = plannedManagedFiles(
      integrations,
      normalizeIntegrationOptions(withInputs.integrationOptions, integrationIds),
    );
    // A root-only integration writes its files at the repository root (#925), as doctor checks.
    if (integrations.some(({ appliesAt }) => appliesAt === "repository-root")) {
      repositoryRoot = findRepositoryRoot(projectDirectory) ?? projectDirectory;
    }
  } catch (error) {
    // apply --dry-run reports the exact refusal; its message can quote the recipe, so only the
    // error's code, or its class when it has none, is kept, which tells a missing Git (ENOENT) or a
    // programming error (TypeError) apart from a recipe apply refuses.
    const { code, name } = /** @type {NodeJS.ErrnoException} */ (error);
    const cause = typeof code === "string" ? code : typeof name === "string" ? name : "Error";
    return {
      managedFiles: [],
      formatterFailures,
      planProblem: `Calavera cannot plan the managed files for the recipe in ${config} (${cause}), so it did not check them. Run apply --dry-run to see what apply refuses, fix the recipe or the cause, then run the command again.`,
    };
  }

  const loadFormatter = managedFileFormatterLoader(projectDirectory, detection, integrations);
  const installDirectory = vitePlusInstallDirectory(detection);
  /** @type {FormatterFailureFinding | undefined} */
  let loadFailure;
  try {
    await loadFormatter();
  } catch (error) {
    loadFailure = formatterFailure(null, error, installDirectory);
    formatterFailures.push(loadFailure);
  }

  const integrationByPath = new Map(
    declaredManagedFiles(integrations.map(({ id }) => id)).map(({ integration, path }) => [
      path,
      integration,
    ]),
  );
  const rootOnly = new Set(
    integrations.filter(({ appliesAt }) => appliesAt === "repository-root").map(({ id }) => id),
  );

  const formatted = await Promise.all(
    plans.map(async (plan) => {
      try {
        return { text: await formatGeneratedText(plan.path, plan.contents, loadFormatter) };
      } catch (error) {
        // A formatter that could not load is reported once, above.
        return loadFailure
          ? { failure: loadFailure }
          : { failure: formatterFailure(plan.path, error, installDirectory), refused: true };
      }
    }),
  );
  // Each refusal once, in plan order, whichever format run ended first.
  for (const { failure, refused } of formatted) {
    if (failure && refused) formatterFailures.push(failure);
  }

  /** @type {ClassifiedManagedFile[]} */
  const managedFiles = [];
  for (const [index, plan] of plans.entries()) {
    // The planner and declaredManagedFiles read the same declarations, so every plan has one.
    const integration = /** @type {string} */ (integrationByPath.get(plan.path));
    const path =
      rootOnly.has(integration) && repositoryRoot !== projectDirectory
        ? relative(projectDirectory, join(repositoryRoot, plan.path))
        : plan.path;
    const stateFile = managedFileStateForPath(state, path);
    managedFiles.push({
      path,
      integration,
      recorded: stateFile !== undefined,
      condition: await managedFileCondition(
        path,
        /** @type {{ text?: string, failure?: FormatterFailureFinding }} */ (formatted[index]),
        stateFile,
      ),
    });
  }

  return { managedFiles, formatterFailures, planProblem: null };
}

/**
 * The condition of one managed file (ADR-0020, Decision 3). A recorded file whose hash equals its
 * record is `current` without the formatter, because apply accepts it; only a recorded file whose
 * hash differs, or an existing file without a record, needs the formatted contents.
 *
 * @param {string} path
 * @param {{ text?: string, failure?: FormatterFailureFinding }} formatted What apply writes, or
 *   the formatter failure that kept Calavera from knowing it.
 * @param {import("./state.js").ManagedFileState | undefined} stateFile
 * @returns {Promise<ClassifiedManagedFile["condition"]>}
 */
async function managedFileCondition(path, formatted, stateFile) {
  if (!(await fileExists(path))) {
    return stateFile
      ? {
          name: "missing",
          reason: `The state records ${path}, and it does not exist, so apply writes it again.`,
        }
      : { name: "pending", reason: `${path} does not exist yet, so apply writes it.` };
  }
  let installed;
  try {
    installed = await readFile(path, "utf8");
  } catch (error) {
    // Only the code is kept: a file-system message can carry text from the project.
    const { code } = /** @type {NodeJS.ErrnoException} */ (error);
    return {
      name: "unreadable",
      reason: `Calavera cannot read ${path} (${code ?? "an error without a code"}), so it cannot compare it with what apply writes.`,
    };
  }
  const current = {
    name: /** @type {const} */ ("current"),
    reason: `${path} matches what the state records or what apply writes, so apply accepts it.`,
  };
  if (stateFile?.hash === textHash(installed)) return current;
  if (formatted.text === undefined) {
    const kind = formatted.failure?.kind ?? "an error that is not a formatter failure";
    return {
      name: "not-checked",
      reason: `Calavera could not format what apply writes for ${path} (${kind}), so it cannot tell whether apply stops on it. The formatter failure gives the remedy.`,
    };
  }
  const difference = managedFileDifference(path, installed, formatted.text, stateFile);
  if (difference === "accepted") return current;
  if (difference === "edited") {
    return {
      name: "edited",
      reason: `${path} differs from what the state records and from what apply writes, so the next apply or update keeps it and stops on it.`,
    };
  }
  return {
    name: "unrecorded",
    reason: `${path} already exists without a state record and differs from what apply writes, so apply stops on it as not recorded as Calavera-managed.`,
  };
}

/**
 * The finding for a formatter that could not load or that refused a file, in Calavera's own words
 * for each kind of failure, with that kind's remedy. It never quotes the error's message, which
 * can hold a value from the person's `.editorconfig`, and never the formatter's output.
 *
 * @param {string | null} path
 * @param {unknown} error
 * @param {string | undefined} installDirectory Where `vp install` installs vite-plus when that is
 *   not the project directory (#1084), as apply's own remedy names it.
 * @returns {FormatterFailureFinding}
 */
function formatterFailure(path, error, installDirectory) {
  const kind = error instanceof FormatterFailure ? error.kind : null;
  const file = path ?? "the managed files";
  const stops = "so apply stops on the same thing";
  const again = "then run the command again";
  const install = installDirectory ? `vp install in ${installDirectory}` : "vp install";
  /** @type {Record<FormatterFailureKind, string>} */
  const reasons = {
    "not-installed": `The project uses Vite+, but Calavera cannot find its vite-plus package, so it cannot format the managed files the way apply does, and apply stops on the same thing. Run ${install}, ${again}.`,
    "no-vp-command": `The project's vite-plus package has no vp command, so Calavera cannot format the managed files the way apply does, and apply stops on the same thing. Run vp install, ${again}.`,
    "editorconfig-change": `Calavera's .editorconfig would change how vp fmt formats ${file}, ${stops}, because Calavera formats every file before it writes any of them. Save the .editorconfig that apply --dry-run prints in the project root, or leave editorconfig out of the recipe, ${again}.`,
    "editorconfig-removal": `Removing Calavera's .editorconfig would change how vp fmt formats ${file}. Delete .editorconfig yourself, or keep editorconfig in the recipe, ${again}.`,
    timeout: `vp fmt did not finish formatting ${file} in time, ${stops}. Check that vite.config.ts does not wait on anything when vp fmt loads it, ${again}.`,
    failed: `vp fmt could not format ${file}, ${stops}. Calavera does not show vp fmt's output, because it can quote the file. Check that vite.config.ts loads without errors, which vp fmt --check in the project reports, ${again}.`,
    "printed-output": `vp fmt returned something with the formatted text of ${file}, such as output that vite.config.ts printed, ${stops}. Make vite.config.ts print nothing when it loads, ${again}.`,
    "changed-content": `vp fmt returned text for ${file} that lost or changed what Calavera sent, ${stops}. Check the fmt settings in vite.config.ts, ${again}.`,
  };
  if (kind !== null) return { path, kind, reason: reasons[kind] };
  const { code } = /** @type {NodeJS.ErrnoException} */ (error);
  return {
    path,
    kind,
    reason: `Calavera could not ${path ? `format ${path}` : "load the project's formatter"} (${typeof code === "string" ? code : "an error without a code"}), ${stops}. Run apply --dry-run for the details, ${again}.`,
  };
}
