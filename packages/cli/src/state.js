// @ts-check
import { isNotEmptyString, isPlainObject, isStringArray } from "./utils/guards.js";
import { assertSafeRelativePath } from "./utils/fs.js";

/**
 * @typedef {import("./ai/artifacts.js").AiArtifactState} AiArtifactState
 * @typedef {import("./ai/artifact-wiring.js").WiringRecord} WiringRecord
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
 */

/**
 * @returns {CalaveraState}
 */
export function createEmptyState() {
  return {
    version: 1,
    integrations: [],
    files: [],
    managedFiles: [],
    aiArtifacts: [],
    aiWiring: [],
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
            Object.values(record.viteHooks).every(isNotEmptyString))) &&
        (record.claudeCode === undefined || isPlainObject(record.claudeCode)),
    )
  ) {
    throw new Error("Calavera state contains invalid aiWiring entries.");
  }

  return /** @type {WiringRecord[]} */ (value);
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
  };
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
