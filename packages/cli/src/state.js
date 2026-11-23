// @ts-check
import artifactSchema from "../schemas/calavera-artifact.schema.json" with { type: "json" };
import { isNotEmptyString, isPlainObject, isStringArray } from "./utils/guards.js";
import { assertSafeRelativePath } from "./utils/fs.js";

// The hooks a manifest may wire. A recorded hook name becomes a path under .vite-hooks/, so a
// name from a damaged or hand-edited state file must not reach a file outside it.
// A recorded integration id is printed in the dry run, so a damaged or hand-edited state file must
// not carry control characters into the approval boundary. Catalog ids are lowercase kebab case.
const INTEGRATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VITE_HOOK_NAMES = new Set(
  artifactSchema.properties.wiring.properties.viteHooks.propertyNames.enum,
);

/**
 * @typedef {import("./ai/artifacts.js").AiArtifactState} AiArtifactState
 * @typedef {import("./ai/artifact-wiring.js").WiringRecord} WiringRecord
 * @typedef {import("./ignore-lines.js").IgnoreLines} IgnoreLines
 *
 * @typedef {object} ManagedFileState
 * @property {string} path
 * @property {string} [hash]
 *
 * @typedef {object} CalaveraState
 * @property {number} version
 * @property {string} [profile]
 * @property {string[]} integrations
 * @property {string[]} files
 * @property {ManagedFileState[]} managedFiles
 * @property {AiArtifactState[]} aiArtifacts
 * @property {WiringRecord[]} aiWiring The hook lines and settings groups apply wrote for each artifact (ADR-0015, Decision 5).
 * @property {IgnoreLines[]} gitignoreBlocks The lines apply wrote in each integration's .gitignore block, and in the block that keeps the artifact cache out of Git (ADR-0016).
 * @property {{ hash: string }} [createdPackageJSON] Present while an apply that created package.json with the package manager's init command has not finished its install (#1085): the hash of the package.json text Calavera last wrote. While package.json still has that text, apply formats it with the project's formatter, so a run that stopped after init leaves a file the next run formats. A file with other text is the person's, and keeps its key order. The apply that runs the install drops the record.
 * @property {string | null} [qualityScript] The value apply last wrote to the package.json `quality` script, kept while the recipe does not request quality and the project still has that value (#968), or null otherwise, so a later apply removes only a value it can show it wrote (#230). A state file from a release before #230 does not have it.
 */

/**
 * Whether apply wrote `state` before. Only after an earlier apply are the project's config and
 * scripts Calavera's to compare and rename (ADR-0013, Decision 6). The state file alone does not
 * show that, because `artifacts install`, `artifacts update`, `artifacts status --check-updates`,
 * and the bootstrap write it too (#960). The profile does: no other command sets it, and apply
 * records it on every run. Releases before this one skipped it only for an apply that installed
 * nothing but artifacts into a project without a profile, which wrote no script to rename.
 *
 * @param {CalaveraState} state
 * @returns {boolean}
 */
export function stateShowsEarlierApply(state) {
  return state.profile !== undefined;
}

/**
 * @returns {CalaveraState}
 */
export function createEmptyState() {
  return {
    version: 1,
    // Present though unset, in the place normalizeState gives it, so a state file keeps one key
    // order whether apply records the profile on the first run or a later one.
    profile: undefined,
    integrations: [],
    files: [],
    managedFiles: [],
    aiArtifacts: [],
    aiWiring: [],
    gitignoreBlocks: [],
    qualityScript: null,
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
export function optionalStringArray(value, label) {
  if (value === undefined) {
    return [];
  }

  if (!isStringArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @returns {ManagedFileState[]}
 */
function normalizeManagedFiles(value) {
  if (value === undefined) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    !value.every(
      (file) =>
        isPlainObject(file) &&
        isNotEmptyString(file.path) &&
        (file.hash === undefined || isNotEmptyString(file.hash)),
    )
  ) {
    throw new Error("Calavera state contains invalid managedFiles entries.");
  }

  return /** @type {ManagedFileState[]} */ (value).map((file) => ({
    ...file,
    path: assertSafeRelativePath(file.path, "Managed file path"),
  }));
}

/**
 * @param {unknown} value
 * @returns {AiArtifactState[]}
 */
function normalizeAiArtifacts(value) {
  if (value === undefined) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    !value.every(
      (artifact) =>
        isPlainObject(artifact) &&
        (artifact.type === "skill" || artifact.type === "hook" || artifact.type === "agent") &&
        isNotEmptyString(artifact.name) &&
        isNotEmptyString(artifact.source) &&
        isNotEmptyString(artifact.path) &&
        isNotEmptyString(artifact.hash) &&
        (artifact.target === undefined || isNotEmptyString(artifact.target)),
    )
  ) {
    throw new Error("Calavera state contains invalid aiArtifacts entries.");
  }

  return /** @type {AiArtifactState[]} */ (value).map((artifact) => ({
    ...artifact,
    path: assertSafeRelativePath(artifact.path, "AI artifact path"),
  }));
}

/**
 * Checks the shape of the wiring records. The planners check the groups inside a record again when
 * they use them, and name the artifact whose record is damaged.
 *
 * @param {unknown} value
 * @returns {WiringRecord[]}
 */
function normalizeAiWiring(value) {
  if (value === undefined) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    !value.every(
      (record) =>
        isPlainObject(record) &&
        isNotEmptyString(record.artifact) &&
        (record.viteHooks === undefined ||
          (isPlainObject(record.viteHooks) &&
            Object.entries(record.viteHooks).every(
              ([hook, line]) => VITE_HOOK_NAMES.has(hook) && isNotEmptyString(line),
            ))) &&
        (record.claudeCode === undefined || isPlainObject(record.claudeCode)),
    )
  ) {
    throw new Error("Calavera state contains invalid aiWiring entries.");
  }

  return /** @type {WiringRecord[]} */ (value);
}

/**
 * Checks the shape of the .gitignore block records. A recorded line is only compared with the
 * file, never written, so a damaged record can at worst make apply report a conflict.
 *
 * @param {unknown} value
 * @returns {IgnoreLines[]}
 */
function normalizeGitignoreBlocks(value) {
  if (value === undefined) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    !value.every(
      (record) =>
        isPlainObject(record) &&
        typeof record.integration === "string" &&
        INTEGRATION_ID.test(record.integration) &&
        isStringArray(record.lines),
    )
  ) {
    throw new Error("Calavera state contains invalid gitignoreBlocks entries.");
  }

  return /** @type {IgnoreLines[]} */ (value);
}

/**
 * Normalize persisted state once at the boundary. Legacy state files with only
 * `files` are migrated to the current `managedFiles` shape in memory.
 *
 * @param {unknown} rawState
 * @returns {CalaveraState}
 */
export function normalizeState(rawState) {
  if (rawState === undefined) {
    return createEmptyState();
  }

  if (!isPlainObject(rawState)) {
    throw new Error("Calavera state file must contain a JSON object.");
  }

  const legacyFiles = optionalStringArray(rawState.files, "Calavera state files");
  const managedFiles =
    rawState.managedFiles === undefined
      ? legacyFiles.map((path) => ({ path }))
      : normalizeManagedFiles(rawState.managedFiles);

  return {
    version: typeof rawState.version === "number" ? rawState.version : 1,
    profile: typeof rawState.profile === "string" ? rawState.profile : undefined,
    integrations: optionalStringArray(rawState.integrations, "Calavera state integrations"),
    files: managedFiles.map((file) => file.path),
    managedFiles,
    aiArtifacts: normalizeAiArtifacts(rawState.aiArtifacts),
    aiWiring: normalizeAiWiring(rawState.aiWiring),
    gitignoreBlocks: normalizeGitignoreBlocks(rawState.gitignoreBlocks),
    ...(rawState.createdPackageJSON === undefined
      ? {}
      : { createdPackageJSON: normalizeCreatedPackageJSON(rawState.createdPackageJSON) }),
    // Absent stays absent: it marks a state file from a release before #230.
    ...(rawState.qualityScript === undefined
      ? {}
      : { qualityScript: normalizeQualityScript(rawState.qualityScript) }),
  };
}

/**
 * @param {unknown} value
 * @returns {{ hash: string }}
 */
function normalizeCreatedPackageJSON(value) {
  if (!isPlainObject(value) || !isNotEmptyString(value.hash)) {
    throw new Error("Calavera state createdPackageJSON must be an object with a hash string.");
  }

  return { hash: value.hash };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeQualityScript(value) {
  if (value !== null && typeof value !== "string") {
    throw new Error("Calavera state qualityScript must be a string or null.");
  }

  return value;
}

/**
 * @param {CalaveraState} state
 * @param {string} path
 * @returns {ManagedFileState | undefined}
 */
export function managedFileStateForPath(state, path) {
  return managedFilesFromState(state).find((file) => file.path === path);
}

/**
 * @param {CalaveraState} state
 * @returns {ManagedFileState[]}
 */
export function managedFilesFromState(state) {
  if (!state || !Array.isArray(state.managedFiles)) {
    throw new Error("Expected normalized Calavera state with managedFiles.");
  }

  return state.managedFiles;
}

/**
 * The `aiArtifacts` records after a command installs `installed`: the installed records first, in
 * the order the command installed them, then every earlier record of another path, in its earlier
 * order. #829: a deselected artifact keeps the record of what was installed, so clean can remove
 * its unedited output and report an edited one. Apply and `artifacts install` and `update` share
 * this order, so a run that installs the same records again writes the same state (#1139).
 *
 * @param {AiArtifactState[]} previous
 * @param {AiArtifactState[]} installed
 * @returns {AiArtifactState[]}
 */
export function mergeInstalledAiArtifacts(previous, installed) {
  const installedPaths = new Set(installed.map(({ path }) => path));
  return [...installed, ...previous.filter(({ path }) => !installedPaths.has(path))];
}
