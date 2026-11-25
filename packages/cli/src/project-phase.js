// @ts-check
import { resolve } from "node:path";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import semver from "semver";

import {
  AI_ARTIFACT_OUTPUT_FOLDERS,
  BASE_SKILL_PATH,
  aiArtifactOutputPaths,
  hashAiInstall,
  resolveAiArtifacts,
} from "./ai/artifacts.js";
import {
  LOCK_PATH,
  normalizePackageSelections,
  pendingRollbackFiles,
  readLock,
  readState,
  STATE_PATH,
  TRANSACTION_PATH,
} from "./artifact-lifecycle.js";
import { readEjectedMarker } from "./ejected-marker.js";
import { stateShowsEarlierApply } from "./state.js";
import { fileExists, isPathInside, readJSON } from "./utils/fs.js";
import { isPlainObject } from "./utils/guards.js";

/**
 * @typedef {import("./artifact-lifecycle.js").ArtifactLockEntry} ArtifactLockEntry
 * @typedef {import("./ejected-marker.js").EjectedMarker} EjectedMarker
 *
 * @typedef {"pending-transaction" | "unmanaged" | "ejected" | "bootstrapped" | "composed" | "applied" | "drifted" | "incomplete"} ProjectPhase
 * @typedef {"pending" | "current" | "missing" | "unreadable" | "edited" | "unrecorded"} ArtifactConditionName
 * @typedef {{ name: ArtifactConditionName, reason: string }} Condition
 *
 * @typedef {object} ArtifactOutput One output path of an artifact, as the state and the disk show it.
 * @property {string} path
 * @property {boolean} installed The path exists.
 * @property {boolean} managed The state holds a record for the path.
 * @property {boolean} locallyEdited The path exists, has a record, and its hash differs from it.
 * @property {string | null} unreadable The error code when the path exists, has a record, and
 *   cannot be hashed, such as ENOTDIR for a file where a skill's folder belongs; null otherwise.
 *
 * @typedef {object} ClassifiedArtifact
 * @property {string} id
 * @property {ArtifactLockEntry | null} lockEntry The lock entry, or null for a selection without one.
 * @property {boolean | null} selected Whether the recipe selects the artifact, or null without a recipe.
 * @property {ArtifactOutput[]} outputs
 * @property {Condition} condition
 *
 * @typedef {object} ProjectRecords Which of Calavera's records exist, so a doctor can name the
 *   ones that remain and the ones that are missing.
 * @property {boolean} recipe
 * @property {boolean} state
 * @property {boolean} profile The state records a profile, the signal that `apply` ran.
 * @property {number} lockEntries
 * @property {boolean} baseSkillRecorded The state records the base skill that `--init` installs.
 * @property {boolean} baseSkillPresent The base skill's folder exists.
 *
 * @typedef {object} ProjectPhaseResult
 * @property {ProjectPhase} phase
 * @property {ClassifiedArtifact[]} artifacts Every lock entry, then every selection without one.
 *   Empty while a transaction is pending.
 * @property {EjectedMarker | null} marker Null while a transaction is pending.
 * @property {ProjectRecords | null} records Null while a transaction is pending.
 * @property {string[] | null} rollbackFiles While a transaction is pending, the project paths the
 *   rollback would restore or remove, or null when the journal cannot be read. Null otherwise.
 */

/** The artifact conditions that make a project `drifted` after `apply`, for a selected artifact. */
const DRIFTED_CONDITIONS = new Set(["missing", "unreadable", "edited", "unrecorded"]);

/** An artifact ID as the catalog writes it, lowercase kebab case. */
const ARTIFACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTIFACT_TYPES = new Set(["skill", "hook", "agent"]);

/**
 * Derives the project's phase and each artifact's condition from Calavera's records and the
 * files they name, as ADR-0020, Decisions 1 to 3 define them, in the current folder. It writes
 * nothing, and nothing it returns is persisted, so every run computes it again. A pending artifact
 * transaction wins over every other finding: the function then reads only the journal and whether
 * each journaled backup exists, because a rollback may still change the other records.
 *
 * A recipe, state, or lock that cannot be read, parsed, or that fails its shape check stops the
 * function with the reader's error (Decision 7, with the #1213 correction to Amendment 1). Nothing
 * else does. A `.gitignore` that cannot be read makes the marker read as `unreadable`, which counts
 * as no marker, and an artifact output that cannot be hashed gives that artifact the `unreadable`
 * condition while every other artifact is still classified.
 *
 * The phase reads the artifacts the records name. Three parts of ADR-0020 join this function in
 * the pull requests that follow it in the #1112 stack, before any command reads it: managed files
 * and the recorded wiring, which also count toward `drifted`, and the per-output notes of
 * Decision 3 for a selection's output that already exists without a state record, which compare
 * the output with an offline copy of the artifact cache.
 *
 * @param {{ config: string }} options `config` is the recipe path, as `--config` names it.
 * @returns {Promise<ProjectPhaseResult>}
 */
export async function deriveProjectPhase({ config }) {
  if (await fileExists(TRANSACTION_PATH)) {
    return {
      phase: "pending-transaction",
      artifacts: [],
      marker: null,
      records: null,
      rollbackFiles: await pendingRollbackFiles(),
    };
  }

  const recipeFound = await fileExists(config);
  const selections = recipeFound ? await readRecipeSelections(config) : [];
  const stateFound = await fileExists(STATE_PATH);
  const state = await readState();
  const lock = await readLock();
  const marker = await readEjectedMarker();
  const baseSkillRecorded = state.aiArtifacts.some(({ path }) => path === BASE_SKILL_PATH);

  /** @type {ProjectRecords} */
  const records = {
    recipe: recipeFound,
    state: stateFound,
    profile: stateFound && stateShowsEarlierApply(state),
    lockEntries: lock.artifacts.length,
    baseSkillRecorded,
    baseSkillPresent: baseSkillRecorded && (await fileExists(BASE_SKILL_PATH)),
  };

  const hashes = new Map(state.aiArtifacts.map(({ path, hash }) => [path, hash]));
  const selectedIds = new Set(selections.map(({ id }) => id));
  const lockedIds = new Set(lock.artifacts.map(({ id }) => id));
  /** @type {ClassifiedArtifact[]} */
  const artifacts = [];
  for (const [index, entry] of lock.artifacts.entries()) {
    assertLockEntryShape(entry, index);
    const outputs = await artifactOutputs(entry.type, entry.destination, entry.target, hashes);
    const selected = recipeFound ? selectedIds.has(entry.id) : null;
    artifacts.push({
      id: entry.id,
      lockEntry: entry,
      selected,
      outputs,
      condition: lockedCondition(entry, index, selected, outputs),
    });
  }
  for (const selection of selections) {
    if (lockedIds.has(selection.id)) continue;
    // normalizePackageSelections has already refused an ID the catalog does not hold.
    const [resolved] = resolveAiArtifacts({ ai: [selection] });
    if (!resolved) throw new Error(`Could not resolve artifact ${selection.id}.`);
    const outputs = await artifactOutputs(resolved.type, resolved.path, selection.target, hashes);
    artifacts.push({
      id: selection.id,
      lockEntry: null,
      selected: true,
      outputs,
      condition: unlockedCondition(selection.id, outputs),
    });
  }

  return {
    phase: phaseFromRecords(records, marker, artifacts),
    artifacts,
    marker,
    records,
    rollbackFiles: null,
  };
}

/**
 * Stops on a lock entry whose fields a reason or a file check would use and cannot trust, because
 * `readLock` checks only that the lock holds an array (Decision 7). A reason names an entry's ID,
 * so it must have the shape Calavera writes; the version must be valid, although no reason quotes
 * it; the type must be the catalog's for a known ID, so the outputs are hashed as what they are;
 * and the entry's files must lie in an artifact output folder, so a hand-edited destination cannot
 * make the function hash another project file. The message names the entry by its position and
 * quotes none of its text.
 *
 * @param {unknown} entry
 * @param {number} index
 * @returns {asserts entry is ArtifactLockEntry}
 */
function assertLockEntryShape(entry, index) {
  const problem = !isPlainObject(entry)
    ? "is not an object"
    : typeof entry.id !== "string" || !ARTIFACT_ID.test(entry.id)
      ? "has no artifact ID in the form Calavera writes"
      : typeof entry.version !== "string" || semver.valid(entry.version) === null
        ? "has no valid version"
        : typeof entry.type !== "string" || !ARTIFACT_TYPES.has(entry.type)
          ? "has no artifact type Calavera knows"
          : catalogTypeDiffers(entry.id, entry.type)
            ? "has a type that differs from its catalog artifact"
            : entry.target !== undefined && typeof entry.target !== "string"
              ? "has a target that is not a string"
              : typeof entry.destination !== "string" || !inOutputFolder(entry.destination)
                ? "has a destination outside the artifact output folders"
                : undefined;
  if (problem !== undefined) {
    throw new Error(
      `${LOCK_PATH} artifacts[${index}] ${problem}, so Calavera cannot check it. Restore the lock from version control, or run artifacts install to write it again.`,
    );
  }
}

/**
 * Whether the catalog holds the entry's artifact with another type, as a hand-edited `type` would
 * leave it. An ID the catalog no longer holds is left to the output checks.
 *
 * @param {string} id
 * @param {string} type
 */
function catalogTypeDiffers(id, type) {
  const catalogType = artifactForId(id)?.type;
  return catalogType !== undefined && catalogType !== type;
}

/** @param {string} path */
function inOutputFolder(path) {
  const target = resolve(path);
  return AI_ARTIFACT_OUTPUT_FOLDERS.some((folder) => {
    const root = resolve(folder);
    return root !== target && isPathInside(root, target);
  });
}

/**
 * The recipe's artifact selections. The recipe must be a JSON object whose `ai` field, when
 * present, is a list, and every selection must name an artifact the catalog holds, once. A recipe
 * that breaks one of these rules stops the function with a message that names the recipe file
 * (Amendment 1) and quotes none of it; the selection reader's own message names only catalog IDs
 * and positions, and its error stays the cause. `doctor` validates the whole recipe before it
 * classifies, but `artifacts status` and `artifacts doctor` do not, so the function checks what it
 * reads itself.
 *
 * @param {string} config
 */
async function readRecipeSelections(config) {
  const recipe = await readJSON(config);
  if (!isPlainObject(recipe)) throw new Error(`${config} must hold a JSON object.`);
  if (recipe.ai !== undefined && !Array.isArray(recipe.ai)) {
    throw new Error(`${config} ai must be a list of artifact selections.`);
  }
  try {
    return normalizePackageSelections(recipe.ai);
  } catch (error) {
    // normalizePackageSelections throws only its own errors, which name catalog IDs and positions.
    const problem = /** @type {Error} */ (error).message;
    throw new Error(`${config} has an artifact selection Calavera cannot use: ${problem}`, {
      cause: error,
    });
  }
}

/**
 * The phase tree of ADR-0020, Decision 2, checked in order, stopping at the first phase that fits.
 *
 * @param {ProjectRecords} records
 * @param {EjectedMarker} marker
 * @param {ClassifiedArtifact[]} artifacts
 * @returns {ProjectPhase}
 */
function phaseFromRecords(records, marker, artifacts) {
  if (!records.recipe) {
    if (!records.state && records.lockEntries === 0) {
      // Any block with paired markers is the marker, edited or not; a broken marker is none.
      return marker.status === "complete" || marker.status === "edited" ? "ejected" : "unmanaged";
    }
    // The base skill is present only when the state records it, so a state file exists here.
    if (!records.profile && records.lockEntries === 0 && records.baseSkillPresent) {
      return "bootstrapped";
    }
    return "incomplete";
  }
  if (!records.state) return records.lockEntries > 0 ? "incomplete" : "composed";
  if (!records.profile) return "composed";
  const drifted = artifacts.some(
    ({ selected, condition }) => selected === true && DRIFTED_CONDITIONS.has(condition.name),
  );
  return drifted ? "drifted" : "applied";
}

/**
 * Each output path of an artifact with what the disk and the state show for it, computed as
 * `artifacts status` computes `installed`, `managed`, and `locallyEdited`.
 *
 * @param {"skill" | "hook" | "agent"} type
 * @param {string} destination
 * @param {string | undefined} target
 * @param {Map<string, string>} hashes The hash the state records for each output path.
 * @returns {Promise<ArtifactOutput[]>}
 */
async function artifactOutputs(type, destination, target, hashes) {
  return Promise.all(
    aiArtifactOutputPaths({ type, path: destination }).map(async (path) => {
      const recorded = hashes.get(path);
      const installed = await fileExists(path);
      const managed = recorded !== undefined;
      /** @type {ArtifactOutput} */
      const output = { path, installed, managed, locallyEdited: false, unreadable: null };
      if (!installed || !managed) return output;
      try {
        output.locallyEdited = (await hashAiInstall(type, path, target)) !== recorded;
      } catch (error) {
        // Only the code is kept: a file-system message can carry text from the project.
        const { code } = /** @type {NodeJS.ErrnoException} */ (error);
        if (typeof code !== "string") throw error;
        output.unreadable = code;
      }
      return output;
    }),
  );
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The paths of the outputs that pass `test`, as a list a reason can name, with the verb phrase
 * that agrees with their number, or undefined when none passes.
 *
 * @param {ArtifactOutput[]} outputs
 * @param {(output: ArtifactOutput) => boolean} test
 * @param {string} one The phrase after a single path, such as "does not exist".
 * @param {string} several The phrase after several paths, such as "do not exist".
 */
function pathsWhere(outputs, test, one, several) {
  const paths = outputs.filter(test).map(({ path }) => path);
  if (paths.length === 0) return undefined;
  return `${LIST.format(paths)} ${paths.length === 1 ? one : several}`;
}

/**
 * The `unreadable` condition's phrase for the outputs that could not be hashed, each with its
 * error code, or undefined when every output could be.
 *
 * @param {ArtifactOutput[]} outputs
 */
function unreadablePhrase(outputs) {
  const unreadable = outputs.filter((output) => output.unreadable !== null);
  if (unreadable.length === 0) return undefined;
  const paths = LIST.format(unreadable.map(({ path, unreadable: code }) => `${path} (${code})`));
  return `Calavera cannot read ${paths} for the comparison with the state`;
}

/**
 * The condition of a lock entry (ADR-0020, Decision 3). Below `current`, the order is the order of
 * precedence: an output that is missing wins over one Calavera cannot read, that one over an
 * edited one, and an edited one over one without a state record. `unreadable` is not one of
 * ADR-0020's conditions: an output that cannot be hashed would otherwise stop the run, which
 * Decision 7 allows only for the recipe, the state, and the lock. The reason names the entry by its
 * position in the lock and its ID, never its version, because a valid version can still carry
 * text from the lock.
 *
 * @param {ArtifactLockEntry} entry
 * @param {number} index
 * @param {boolean | null} selected
 * @param {ArtifactOutput[]} outputs
 * @returns {Condition}
 */
function lockedCondition(entry, index, selected, outputs) {
  const locked = `The lock entry artifacts[${index}] records ${entry.id}`;
  // #992: install and update drop the entry of an artifact the recipe no longer selects.
  const leftover =
    selected === false
      ? `, the recipe no longer selects it, so artifacts install drops its lock entry`
      : "";
  const missing = pathsWhere(
    outputs,
    ({ installed }) => !installed,
    "does not exist",
    "do not exist",
  );
  if (missing) return { name: "missing", reason: `${locked}${leftover}, and ${missing}.` };
  const unreadable = unreadablePhrase(outputs);
  if (unreadable) {
    return { name: "unreadable", reason: `${locked}${leftover}, and ${unreadable}.` };
  }
  const edited = pathsWhere(
    outputs,
    ({ locallyEdited }) => locallyEdited,
    "differs from the hash the state records",
    "differ from the hashes the state records",
  );
  if (edited) return { name: "edited", reason: `${locked}${leftover}, and ${edited}.` };
  const unrecorded = pathsWhere(
    outputs,
    ({ managed }) => !managed,
    "has no record in the state, so Calavera does not manage it",
    "have no record in the state, so Calavera does not manage them",
  );
  if (unrecorded) {
    return { name: "unrecorded", reason: `${locked}${leftover}, and ${unrecorded}.` };
  }
  return {
    name: "current",
    reason: `${locked}${leftover}, and every file it installed matches the hash the state records.`,
  };
}

/**
 * The condition of a selection without a lock entry (ADR-0020, Decision 3). It is `pending` until
 * an output that has a state record is missing or differs from it: an installed artifact that
 * someone edited or deleted fails whether or not the lock records it (owner decision 10, #994).
 * For a hook with one recorded output out of two, ADR-0020 names no condition ("Items for the
 * implementation issues"); the recorded output decides, as it does when both are recorded.
 *
 * @param {string} id
 * @param {ArtifactOutput[]} outputs
 * @returns {Condition}
 */
function unlockedCondition(id, outputs) {
  const unlocked = `The recipe selects ${id}, which has no lock entry`;
  const missing = pathsWhere(
    outputs,
    ({ installed, managed }) => managed && !installed,
    "does not exist, although the state records it",
    "do not exist, although the state records them",
  );
  if (missing) return { name: "missing", reason: `${unlocked}, and ${missing}.` };
  const unreadable = unreadablePhrase(outputs);
  if (unreadable) return { name: "unreadable", reason: `${unlocked}, and ${unreadable}.` };
  const edited = pathsWhere(
    outputs,
    ({ locallyEdited }) => locallyEdited,
    "differs from the hash the state records",
    "differ from the hashes the state records",
  );
  if (edited) return { name: "edited", reason: `${unlocked}, and ${edited}.` };
  if (outputs.every(({ installed, managed }) => installed && managed)) {
    return {
      name: "pending",
      reason: `${unlocked}, but its files are present and match what the state records, so artifacts install records it in the lock.`,
    };
  }
  const unrecorded = pathsWhere(
    outputs,
    ({ installed, managed }) => installed && !managed,
    "already exists without a state record, so apply stops on it unless it matches the package",
    "already exist without a state record, so apply stops on them unless they match the package",
  );
  if (unrecorded) {
    // apply refuses to replace such a file unless it matches the package (assertSafeAiWrite).
    return {
      name: "pending",
      reason: `${unlocked} yet, and ${unrecorded}.`,
    };
  }
  return {
    name: "pending",
    reason: `${unlocked} yet, so artifacts install or apply installs it.`,
  };
}
