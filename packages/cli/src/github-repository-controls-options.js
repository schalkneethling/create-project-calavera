// @ts-check

export const GITHUB_REPOSITORY_CONTROLS_ID = "github-repository-controls";

const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const CODEQL_LANGUAGES = new Set([
  "actions",
  "c-cpp",
  "csharp",
  "go",
  "java-kotlin",
  "javascript-typescript",
  "python",
  "ruby",
  "swift",
]);
const DEPENDABOT_ECOSYSTEMS = new Set(["npm", "github-actions"]);

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is Record<string, unknown>}
 */
function assertPlainObject(name, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
}

/** @param {string} name @param {Record<string, unknown>} value @param {string[]} fields */
function assertKnownFields(name, value, fields) {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) throw new Error(`Unknown ${name} fields: ${unknown.join(", ")}.`);
}

/** @param {string} name @param {unknown} value @param {string} fallback */
function normalizeString(name, value, fallback) {
  const normalized = value === undefined ? fallback : value;
  if (typeof normalized !== "string" || !normalized.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return normalized.trim();
}

/** @param {string} name @param {unknown} value @param {boolean} fallback */
function normalizeBoolean(name, value, fallback) {
  const normalized = value === undefined ? fallback : value;
  if (typeof normalized !== "boolean") throw new TypeError(`${name} must be a boolean.`);
  return normalized;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {string[]} fallback
 * @param {Set<string>} [allowed]
 */
function normalizeStringArray(name, value, fallback, allowed) {
  const normalized = value === undefined ? fallback : value;
  if (
    !Array.isArray(normalized) ||
    normalized.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new TypeError(`${name} must be an array of non-empty strings.`);
  }
  const unique = [...new Set(normalized.map((item) => item.trim()))];
  if (allowed) {
    const unknown = unique.filter((item) => !allowed.has(item));
    if (unknown.length > 0) throw new Error(`Invalid ${name}: ${unknown.join(", ")}.`);
  }
  return unique;
}

/** @param {unknown} value @param {string} defaultBranch */
function normalizeReleaseEnvironment(value, defaultBranch) {
  if (value === undefined || value === false || value === null) return null;
  assertPlainObject("github-repository-controls.releaseEnvironment", value);
  assertKnownFields("github-repository-controls.releaseEnvironment", value, [
    "name",
    "reviewers",
    "waitTimer",
    "preventSelfReview",
    "branches",
  ]);
  const waitTimer = value.waitTimer ?? 0;
  if (
    typeof waitTimer !== "number" ||
    !Number.isInteger(waitTimer) ||
    waitTimer < 0 ||
    waitTimer > 43_200
  ) {
    throw new Error(
      "github-repository-controls.releaseEnvironment.waitTimer must be an integer from 0 to 43200.",
    );
  }
  const reviewers = normalizeStringArray(
    "github-repository-controls.releaseEnvironment.reviewers",
    value.reviewers,
    [],
  );
  if (reviewers.length === 0) {
    throw new Error(
      "github-repository-controls.releaseEnvironment.reviewers must contain at least one GitHub login.",
    );
  }
  const branches = normalizeStringArray(
    "github-repository-controls.releaseEnvironment.branches",
    value.branches,
    [defaultBranch],
  );
  if (branches.length === 0) {
    throw new Error(
      "github-repository-controls.releaseEnvironment.branches must contain at least one branch.",
    );
  }
  return {
    name: normalizeString(
      "github-repository-controls.releaseEnvironment.name",
      value.name,
      "release",
    ),
    reviewers,
    waitTimer,
    preventSelfReview: normalizeBoolean(
      "github-repository-controls.releaseEnvironment.preventSelfReview",
      value.preventSelfReview,
      false,
    ),
    branches,
  };
}

/** @param {unknown} value */
export function normalizeGithubRepositoryControlsOptions(value) {
  assertPlainObject("integrationOptions.github-repository-controls", value);
  assertKnownFields("integrationOptions.github-repository-controls", value, [
    "repository",
    "defaultBranch",
    "requiredChecks",
    "mergeMethods",
    "wiki",
    "projects",
    "autoMerge",
    "deleteBranchOnMerge",
    "updateBranch",
    "dependabotEcosystems",
    "codeqlLanguages",
    "codeqlQuerySuite",
    "releaseEnvironment",
  ]);

  const repository = normalizeString("github-repository-controls.repository", value.repository, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("github-repository-controls.repository must use owner/name format.");
  }
  const defaultBranch = normalizeString(
    "github-repository-controls.defaultBranch",
    value.defaultBranch,
    "main",
  );
  const mergeMethods = normalizeStringArray(
    "github-repository-controls.mergeMethods",
    value.mergeMethods,
    ["squash"],
    MERGE_METHODS,
  );
  if (mergeMethods.length === 0) {
    throw new Error("github-repository-controls.mergeMethods must contain at least one method.");
  }
  const codeqlQuerySuite = value.codeqlQuerySuite ?? "default";
  if (codeqlQuerySuite !== "default" && codeqlQuerySuite !== "extended") {
    throw new Error("github-repository-controls.codeqlQuerySuite must be default or extended.");
  }
  const dependabotEcosystems = normalizeStringArray(
    "github-repository-controls.dependabotEcosystems",
    value.dependabotEcosystems,
    ["npm", "github-actions"],
    DEPENDABOT_ECOSYSTEMS,
  );
  if (dependabotEcosystems.length === 0) {
    throw new Error("github-repository-controls.dependabotEcosystems must not be empty.");
  }
  const codeqlLanguages = normalizeStringArray(
    "github-repository-controls.codeqlLanguages",
    value.codeqlLanguages,
    ["actions", "javascript-typescript"],
    CODEQL_LANGUAGES,
  );
  if (codeqlLanguages.length === 0) {
    throw new Error("github-repository-controls.codeqlLanguages must not be empty.");
  }

  return {
    repository,
    defaultBranch,
    requiredChecks: normalizeStringArray(
      "github-repository-controls.requiredChecks",
      value.requiredChecks,
      [],
    ),
    mergeMethods,
    wiki: normalizeBoolean("github-repository-controls.wiki", value.wiki, false),
    projects: normalizeBoolean("github-repository-controls.projects", value.projects, false),
    autoMerge: normalizeBoolean("github-repository-controls.autoMerge", value.autoMerge, true),
    deleteBranchOnMerge: normalizeBoolean(
      "github-repository-controls.deleteBranchOnMerge",
      value.deleteBranchOnMerge,
      true,
    ),
    updateBranch: normalizeBoolean(
      "github-repository-controls.updateBranch",
      value.updateBranch,
      true,
    ),
    dependabotEcosystems,
    codeqlLanguages,
    codeqlQuerySuite,
    releaseEnvironment: normalizeReleaseEnvironment(value.releaseEnvironment, defaultBranch),
  };
}
