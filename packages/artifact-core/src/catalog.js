// @ts-check
import manifest1 from "@schalkneethling/calavera-skill-calavera" with { type: "json" };
import manifest2 from "@schalkneethling/calavera-skill-code-review" with { type: "json" };
import manifest3 from "@schalkneethling/calavera-skill-css-tokens" with { type: "json" };
import manifest4 from "@schalkneethling/calavera-skill-frontend-engineering" with { type: "json" };
import manifest5 from "@schalkneethling/calavera-skill-frontend-security" with { type: "json" };
import manifest6 from "@schalkneethling/calavera-skill-frontend-testing" with { type: "json" };
import manifest7 from "@schalkneethling/calavera-skill-github-goal-issue-triage" with { type: "json" };
import manifest8 from "@schalkneethling/calavera-skill-more-secure-dependabot-config" with { type: "json" };
import manifest9 from "@schalkneethling/calavera-skill-npm-publishing-best-practices" with { type: "json" };
import manifest10 from "@schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow" with { type: "json" };
import manifest11 from "@schalkneethling/calavera-skill-project-goal" with { type: "json" };
import manifest12 from "@schalkneethling/calavera-skill-refined-plan-mode" with { type: "json" };
import manifest13 from "@schalkneethling/calavera-hook-auto-approve-safe-commands" with { type: "json" };
import manifest14 from "@schalkneethling/calavera-hook-block-dangerous-commands" with { type: "json" };
import manifest15 from "@schalkneethling/calavera-agent-technical-devils-advocate" with { type: "json" };
import package1 from "@schalkneethling/calavera-skill-calavera/package.json" with { type: "json" };
import package2 from "@schalkneethling/calavera-skill-code-review/package.json" with { type: "json" };
import package3 from "@schalkneethling/calavera-skill-css-tokens/package.json" with { type: "json" };
import package4 from "@schalkneethling/calavera-skill-frontend-engineering/package.json" with { type: "json" };
import package5 from "@schalkneethling/calavera-skill-frontend-security/package.json" with { type: "json" };
import package6 from "@schalkneethling/calavera-skill-frontend-testing/package.json" with { type: "json" };
import package7 from "@schalkneethling/calavera-skill-github-goal-issue-triage/package.json" with { type: "json" };
import package8 from "@schalkneethling/calavera-skill-more-secure-dependabot-config/package.json" with { type: "json" };
import package9 from "@schalkneethling/calavera-skill-npm-publishing-best-practices/package.json" with { type: "json" };
import package10 from "@schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow/package.json" with { type: "json" };
import package11 from "@schalkneethling/calavera-skill-project-goal/package.json" with { type: "json" };
import package12 from "@schalkneethling/calavera-skill-refined-plan-mode/package.json" with { type: "json" };
import package13 from "@schalkneethling/calavera-hook-auto-approve-safe-commands/package.json" with { type: "json" };
import package14 from "@schalkneethling/calavera-hook-block-dangerous-commands/package.json" with { type: "json" };
import package15 from "@schalkneethling/calavera-agent-technical-devils-advocate/package.json" with { type: "json" };

export const DEFAULT_ARTIFACT_TARGET = "claude-code";

const packageVersions = new Map([
  ["@schalkneethling/calavera-skill-calavera", package1.version],
  ["@schalkneethling/calavera-skill-code-review", package2.version],
  ["@schalkneethling/calavera-skill-css-tokens", package3.version],
  ["@schalkneethling/calavera-skill-frontend-engineering", package4.version],
  ["@schalkneethling/calavera-skill-frontend-security", package5.version],
  ["@schalkneethling/calavera-skill-frontend-testing", package6.version],
  ["@schalkneethling/calavera-skill-github-goal-issue-triage", package7.version],
  ["@schalkneethling/calavera-skill-more-secure-dependabot-config", package8.version],
  ["@schalkneethling/calavera-skill-npm-publishing-best-practices", package9.version],
  ["@schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow", package10.version],
  ["@schalkneethling/calavera-skill-project-goal", package11.version],
  ["@schalkneethling/calavera-skill-refined-plan-mode", package12.version],
  ["@schalkneethling/calavera-hook-auto-approve-safe-commands", package13.version],
  ["@schalkneethling/calavera-hook-block-dangerous-commands", package14.version],
  ["@schalkneethling/calavera-agent-technical-devils-advocate", package15.version],
]);

export const artifactCatalog = Object.freeze([
  artifact(manifest1, "@schalkneethling/calavera-skill-calavera", "skills/calavera"),
  artifact(manifest2, "@schalkneethling/calavera-skill-code-review", "skills/code-review"),
  artifact(manifest3, "@schalkneethling/calavera-skill-css-tokens", "skills/css-tokens"),
  artifact(
    manifest4,
    "@schalkneethling/calavera-skill-frontend-engineering",
    "skills/frontend-engineering",
  ),
  artifact(
    manifest5,
    "@schalkneethling/calavera-skill-frontend-security",
    "skills/frontend-security",
  ),
  artifact(
    manifest6,
    "@schalkneethling/calavera-skill-frontend-testing",
    "skills/frontend-testing",
  ),
  artifact(
    manifest7,
    "@schalkneethling/calavera-skill-github-goal-issue-triage",
    "skills/github-goal-issue-triage",
  ),
  artifact(
    manifest8,
    "@schalkneethling/calavera-skill-more-secure-dependabot-config",
    "skills/more-secure-dependabot-config",
  ),
  artifact(
    manifest9,
    "@schalkneethling/calavera-skill-npm-publishing-best-practices",
    "skills/npm-publishing-best-practices",
  ),
  artifact(
    manifest10,
    "@schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow",
    "skills/npm-trusted-publishing-github-workflow",
  ),
  artifact(manifest11, "@schalkneethling/calavera-skill-project-goal", "skills/project-goal"),
  artifact(
    manifest12,
    "@schalkneethling/calavera-skill-refined-plan-mode",
    "skills/refined-plan-mode",
  ),
  artifact(
    manifest13,
    "@schalkneethling/calavera-hook-auto-approve-safe-commands",
    "hooks/auto-approve-safe-commands",
  ),
  artifact(
    manifest14,
    "@schalkneethling/calavera-hook-block-dangerous-commands",
    "hooks/block-dangerous-commands",
  ),
  artifact(
    manifest15,
    "@schalkneethling/calavera-agent-technical-devils-advocate",
    "agents/technical-devils-advocate.md",
  ),
]);

/**
 * @param {{ id: string, type: string, displayName: string, payload: string, [key: string]: unknown }} manifest
 * @param {string} packageName
 * @param {string} legacyPath
 */
function artifact(manifest, packageName, legacyPath) {
  return Object.freeze({
    ...manifest,
    packageName,
    version: packageVersions.get(packageName),
    legacyPath,
    group: manifest.type === "skill" ? "Skills" : manifest.type === "hook" ? "Hooks" : "Agents",
    defaultTarget: manifest.type === "skill" ? undefined : DEFAULT_ARTIFACT_TARGET,
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
