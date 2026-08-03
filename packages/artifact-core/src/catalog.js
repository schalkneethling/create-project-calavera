// @ts-check

export const DEFAULT_ARTIFACT_TARGET = "claude-code";

const ARTIFACT_SCHEMA =
  "https://calavera.schalkneethling.com/schemas/calavera-artifact.schema.json";
const DEFAULT_COMPATIBILITY = ">=2.2.0 <3";
const ARTIFACT_TARGETS = Object.freeze(["claude-code", "codex", "cursor", "opencode"]);
/** @type {readonly (readonly [string, string, string?])[]} */
const definitions = Object.freeze([
  ["skill-calavera", "Calavera"],
  ["skill-code-review", "Code review"],
  ["skill-css-tokens", "CSS tokens"],
  ["skill-frontend-engineering", "Frontend engineering"],
  ["skill-frontend-security", "Frontend security"],
  ["skill-frontend-testing", "Frontend testing"],
  ["skill-github-goal-issue-triage", "GitHub goal issue triage"],
  ["skill-more-secure-dependabot-config", "More secure Dependabot config"],
  ["skill-npm-publishing-best-practices", "npm publishing best practices"],
  ["skill-npm-trusted-publishing-github-workflow", "npm trusted publishing GitHub workflow"],
  ["skill-project-goal", "Project goal"],
  ["skill-refined-plan-mode", "Refined plan mode"],
  ["skill-release-with-confidence", "Release with confidence", ">=2.4.0-next.0 <3"],
  ["hook-auto-approve-safe-commands", "Auto-approve safe commands"],
  ["hook-block-dangerous-commands", "Block dangerous commands"],
  ["agent-technical-devils-advocate", "Technical devil's advocate"],
]);

export const artifactCatalog = Object.freeze(definitions.map(createArtifact));

/** @param {readonly [string, string, string?]} definition */
function createArtifact([id, displayName, calavera = DEFAULT_COMPATIBILITY]) {
  const separator = id.indexOf("-");
  const type = id.slice(0, separator);
  const slug = id.slice(separator + 1);
  const isAgent = type === "agent";
  const usesTargetAdapter = type !== "skill";

  return Object.freeze({
    $schema: ARTIFACT_SCHEMA,
    schemaVersion: 1,
    id,
    type,
    displayName,
    payload: `payload/${slug}${isAgent ? ".md" : ""}`,
    ...(usesTargetAdapter ? { targets: ARTIFACT_TARGETS } : {}),
    compatibility: { calavera },
    packageName: `@schalkneethling/calavera-${id}`,
    legacyPath: `${type}s/${slug}${isAgent ? ".md" : ""}`,
    group: type === "skill" ? "Skills" : type === "hook" ? "Hooks" : "Agents",
    defaultTarget: usesTargetAdapter ? DEFAULT_ARTIFACT_TARGET : undefined,
  });
}

/** @param {string} id */
export function artifactForId(id) {
  return artifactCatalog.find((artifact) => artifact.id === id);
}

/** @param {string} path */
export function artifactForLegacyPath(path) {
  return artifactCatalog.find((artifact) => artifact.legacyPath === path);
}
