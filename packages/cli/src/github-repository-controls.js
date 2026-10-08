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
      codeScanning: options.requireCodeqlResults
        ? {
            alertsThreshold: "errors_and_warnings",
            securityAlertsThreshold: "medium_or_higher",
          }
        : null,
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
  const codeqlRequired = Boolean(config.mainRuleset.codeScanning);
  const querySuite = config.security.codeqlDefaultSetup.querySuite;
  const codeqlMergeProtection = codeqlRequired
    ? `The generated policy uses the ${querySuite} query suite and requires CodeQL results, blocking errors and warnings plus medium-or-higher security alerts. Edit \`mainRuleset.codeScanning\` in the committed policy to choose thresholds; set it to null to leave scanning rules unmanaged (existing remote rules are retained). Older policies without this field leave scanning rules unmanaged. Re-applying the Calavera recipe regenerates the policy.

Checks verify active branch enforcement, default-branch scope without exclusions, and an explicitly empty bypass list. Applying repairs these shared protections and preserves unrelated rules and other scanners. Review the plan before applying.

GitHub must support code-scanning merge protection for the repository. A required scan must have results for both the commit and target reference. See [GitHub rules documentation](https://docs.github.com/en/rest/repos/rules).
`
    : `The generated policy uses the ${querySuite} query suite and does not manage the code scanning rule, because the recipe sets \`requireCodeqlResults\` to false. Calavera neither creates, changes, nor removes that rule. A code scanning rule that already exists in the ruleset stays and keeps requiring CodeQL results; to stop requiring them, delete it in **Settings → Rules**. To have Calavera require CodeQL results, set \`requireCodeqlResults\` to true in the recipe and re-apply it.

Checks verify active branch enforcement, default-branch scope without exclusions, and an explicitly empty bypass list. Applying repairs these shared protections and preserves unrelated rules and other scanners. Review the plan before applying.
`;
  const requiredChecksList =
    config.mainRuleset.requiredChecks.length > 0
      ? `The generated policy requires these status checks: ${config.mainRuleset.requiredChecks.map((check) => `\`${check}\``).join(", ")}.`
      : `The generated policy requires no status checks, so \`mainRuleset.requiredChecks\` is empty.`;
  const requiredChecksDocumentation = `${requiredChecksList} A required check is the exact name that a check reports on a pull request, usually the workflow job name. A name that no check reports blocks every merge, so add names only after your first continuous integration run.

To require another check, add its name to \`requiredChecks\` in the Calavera recipe and re-apply the recipe. Do not add checks to the \`${config.mainRuleset.name}\` ruleset in the repository settings: the drift check reports them and apply removes them. To require a check outside Calavera, create a separate ruleset in the repository settings that Calavera does not manage. See [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) and [Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).`;
  const codeqlPartialApply = codeqlRequired
    ? `If CodeQL default setup does not apply, the ruleset still requires CodeQL results, so it blocks merges until CodeQL default setup is configured and reports results. Set \`mainRuleset.codeScanning\` to null so that Calavera no longer manages the rule. A rule that already exists stays and keeps blocking merges; delete it in **Settings → Rules** to stop requiring CodeQL results.
`
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

## CodeQL merge protection

${codeqlMergeProtection}
## Required status checks

${requiredChecksDocumentation}

## CodeQL languages

GitHub rejects a default setup language that it does not detect in the repository. The drift check reports such a language as blocked, with the reason. GitHub detects \`actions\` when the default branch has workflow files in \`.github/workflows/\`. Add the missing code, or remove the language from \`security.codeqlDefaultSetup.languages\`, then run the drift check again. GitHub can take a short time to detect code after a push.

## Partial apply

Apply runs the default-branch ruleset first, CodeQL default setup last, and every other change in between. A failed change does not stop the others; a change runs only after the changes it requires (Dependabot security updates require Dependabot alerts). A blocked CodeQL language skips CodeQL default setup and nothing else. An apply that does not fully succeed ends with a summary of the changes applied, failed (with the error), and not attempted, with what to do about each, and exits with a non-zero code.

${codeqlPartialApply}
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
