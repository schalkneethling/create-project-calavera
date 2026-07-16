export const DEFAULT_AI_TARGET = "claude-code";

export const aiArtifactCatalog = [
  aiArtifact("skill-calavera", "skill", "skills/calavera", "Calavera", "Skills"),
  aiArtifact("skill-code-review", "skill", "skills/code-review", "Code review", "Skills"),
  aiArtifact("skill-css-tokens", "skill", "skills/css-tokens", "CSS tokens", "Skills"),
  aiArtifact(
    "skill-frontend-engineering",
    "skill",
    "skills/frontend-engineering",
    "Frontend engineering",
    "Skills",
  ),
  aiArtifact(
    "skill-frontend-security",
    "skill",
    "skills/frontend-security",
    "Frontend security",
    "Skills",
  ),
  aiArtifact(
    "skill-frontend-testing",
    "skill",
    "skills/frontend-testing",
    "Frontend testing",
    "Skills",
  ),
  aiArtifact(
    "skill-github-goal-issue-triage",
    "skill",
    "skills/github-goal-issue-triage",
    "GitHub goal issue triage",
    "Skills",
  ),
  aiArtifact(
    "skill-more-secure-dependabot-config",
    "skill",
    "skills/more-secure-dependabot-config",
    "More secure Dependabot config",
    "Skills",
  ),
  aiArtifact(
    "skill-npm-publishing-best-practices",
    "skill",
    "skills/npm-publishing-best-practices",
    "npm publishing best practices",
    "Skills",
  ),
  aiArtifact(
    "skill-npm-trusted-publishing-github-workflow",
    "skill",
    "skills/npm-trusted-publishing-github-workflow",
    "npm trusted publishing GitHub workflow",
    "Skills",
  ),
  aiArtifact("skill-project-goal", "skill", "skills/project-goal", "Project goal", "Skills"),
  aiArtifact(
    "skill-refined-plan-mode",
    "skill",
    "skills/refined-plan-mode",
    "Refined plan mode",
    "Skills",
  ),
  aiArtifact(
    "hook-auto-approve-safe-commands",
    "hook",
    "hooks/auto-approve-safe-commands",
    "Auto-approve safe commands",
    "Hooks",
    DEFAULT_AI_TARGET,
  ),
  aiArtifact(
    "hook-block-dangerous-commands",
    "hook",
    "hooks/block-dangerous-commands",
    "Block dangerous commands",
    "Hooks",
    DEFAULT_AI_TARGET,
  ),
  aiArtifact(
    "agent-technical-devils-advocate",
    "agent",
    "agents/technical-devils-advocate.md",
    "Technical devil's advocate",
    "Agents",
    DEFAULT_AI_TARGET,
  ),
];

function aiArtifact(id, type, src, label, group, defaultTarget) {
  return {
    id,
    type,
    src,
    label,
    group,
    status: "bundled",
    defaultTarget,
  };
}
