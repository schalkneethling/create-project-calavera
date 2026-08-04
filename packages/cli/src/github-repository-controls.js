// @ts-check
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stringify as stringifyYaml } from "yaml";
import {
  GITHUB_REPOSITORY_CONTROLS_ID,
  normalizeGithubRepositoryControlsOptions,
} from "./github-repository-controls-options.js";

export { GITHUB_REPOSITORY_CONTROLS_ID, normalizeGithubRepositoryControlsOptions };

const TEMPLATE_LIMIT = 256 * 1024;
const TEMPLATE_PATH = fileURLToPath(
  new URL("./templates/repository-controls.mjs", import.meta.url),
);

function readBoundedTemplate() {
  const before = lstatSync(TEMPLATE_PATH);
  if (!before.isFile()) throw new Error("Repository-controls template must be a regular file.");
  if (before.size > TEMPLATE_LIMIT) {
    throw new Error(`Repository-controls template exceeds ${TEMPLATE_LIMIT} bytes.`);
  }
  const contents = readFileSync(TEMPLATE_PATH);
  if (contents.byteLength > TEMPLATE_LIMIT) {
    throw new Error(`Repository-controls template exceeded ${TEMPLATE_LIMIT} bytes while reading.`);
  }
  return contents.toString("utf8");
}

/** @param {ReturnType<typeof normalizeGithubRepositoryControlsOptions>} options */
export function createRepositoryControlsConfig(options) {
  return {
    schemaVersion: 1,
    repository: options.repository,
    defaultBranch: options.defaultBranch,
    repositorySettings: {
      wiki: options.wiki,
      projects: options.projects,
      mergeMethods: options.mergeMethods,
      autoMerge: options.autoMerge,
      deleteBranchOnMerge: options.deleteBranchOnMerge,
      updateBranch: options.updateBranch,
    },
    workflowPermissions: {
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
    },
    security: {
      dependabotAlerts: true,
      dependabotSecurityUpdates: true,
      codeqlDefaultSetup: {
        state: "configured",
        languages: options.codeqlLanguages,
        querySuite: options.codeqlQuerySuite,
        threatModel: "remote",
        runnerType: "standard",
        runnerLabel: null,
      },
    },
    mainRuleset: {
      name: "protect-default-branch",
      requiredChecks: options.requiredChecks,
      allowedMergeMethods: options.mergeMethods,
    },
    releaseEnvironment: options.releaseEnvironment
      ? {
          ...options.releaseEnvironment,
          customBranchesOnly: true,
          guardValue: "approved-release-environment-v1",
        }
      : null,
    manualControls: {
      dependabotMalwareAlerts: true,
      disableEnvironmentAdminBypass: Boolean(options.releaseEnvironment),
    },
  };
}

/** @param {string[]} ecosystems */
export function createDependabotConfig(ecosystems) {
  return stringifyYaml({
    version: 2,
    updates: ecosystems.map((ecosystem) => ({
      "package-ecosystem": ecosystem,
      directory: "/",
      schedule: { interval: "weekly" },
      cooldown: { "default-days": 7, include: ["*"] },
    })),
  });
}

/** @param {ReturnType<typeof createRepositoryControlsConfig>} config */
function createRepositoryControlsDocumentation(config) {
  const release = config.releaseEnvironment
    ? `\n- In **Settings → Environments → ${config.releaseEnvironment.name}**, disable administrator bypass.\n`
    : "";
  return `# Repository controls

Calavera generated a committed desired-state policy for \`${config.repository}\`.

Run the read-only drift check before applying any remote changes:

\`\`\`sh
node scripts/repository-controls.mjs
\`\`\`

Review the reported plan, then apply it interactively:

\`\`\`sh
node scripts/repository-controls.mjs --apply
\`\`\`

For intentional unattended administration, add \`--yes\` to the apply command.

## Manual controls

- In **Settings → Advanced Security**, enable Dependabot malware alerts.${release}
The generated script verifies the repository identity before planning or applying changes. Unsupported GitHub plan features are reported separately from drift.
`;
}

/** @param {unknown} rawOptions */
export function githubRepositoryControlManagedFiles(rawOptions) {
  const options = normalizeGithubRepositoryControlsOptions(rawOptions);
  const config = createRepositoryControlsConfig(options);
  return [
    {
      path: ".github/repository-controls.json",
      contents: `${JSON.stringify(config, null, 2)}\n`,
    },
    {
      path: ".github/dependabot.yml",
      contents: createDependabotConfig(options.dependabotEcosystems),
    },
    { path: "scripts/repository-controls.mjs", contents: readBoundedTemplate() },
    {
      path: "docs/repository-controls.md",
      contents: createRepositoryControlsDocumentation(config),
    },
  ];
}
