#!/usr/bin/env node
/* eslint-disable no-console */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_VERSION = "2026-03-10";
const CONFIG_LIMIT = 1024 * 1024;
const API_RESPONSE_LIMIT = 20 * 1024 * 1024;
const CODEQL_ATTEMPTS = 12;
const CODEQL_DELAY_MS = 5_000;
const MAX_PAGES = 100;
const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = fileURLToPath(new URL("../.github/repository-controls.json", import.meta.url));

export function readBoundedJson(path, limit = CONFIG_LIMIT) {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error(`${path} must be a regular file.`);
  if (before.size > limit) throw new Error(`${path} exceeds the ${limit}-byte safety limit.`);
  const contents = readFileSync(path);
  if (contents.byteLength > limit) {
    throw new Error(`${path} exceeded the ${limit}-byte safety limit while being read.`);
  }
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON.`, { cause: error });
    }
    throw error;
  }
}

export class GitHubApi {
  request(method, endpoint, body) {
    const args = [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      "-X",
      method,
      endpoint,
    ];
    if (body !== undefined) args.push("--input", "-");
    try {
      const output = execFileSync("gh", args, {
        encoding: "utf8",
        input: body === undefined ? undefined : JSON.stringify(body),
        maxBuffer: API_RESPONSE_LIMIT,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return output ? JSON.parse(output) : undefined;
    } catch (error) {
      const stderr = String(error?.stderr ?? "").trim();
      const failure = new Error(
        `GitHub API ${method} ${endpoint} failed${stderr ? `: ${stderr}` : ""}.`,
        { cause: error },
      );
      failure.status = Number(stderr.match(/HTTP ([0-9]{3})/)?.[1] ?? 0);
      throw failure;
    }
  }

  optional(endpoint) {
    try {
      return this.request("GET", endpoint);
    } catch (error) {
      if (error.status === 404 || /HTTP 404|Not Found/i.test(String(error))) return null;
      throw error;
    }
  }

  capability(endpoint, options = {}) {
    try {
      if (!options.paginate) {
        return { supported: true, value: this.request("GET", endpoint) };
      }
      const value = [];
      const separator = endpoint.includes("?") ? "&" : "?";
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = this.request("GET", `${endpoint}${separator}per_page=100&page=${page}`);
        if (!Array.isArray(response)) {
          throw new Error(`GitHub API GET ${endpoint} did not return a paginated array.`);
        }
        value.push(...response);
        if (response.length < 100) return { supported: true, value };
      }
      throw new Error(`GitHub API GET ${endpoint} exceeded ${MAX_PAGES} pages.`);
    } catch (error) {
      if (
        error.status === 403 ||
        error.status === 404 ||
        /HTTP 403|HTTP 404|Forbidden|Not Found/i.test(String(error))
      ) {
        return { supported: false, detail: String(error) };
      }
      throw error;
    }
  }
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: API_RESPONSE_LIMIT,
      stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}.`, {
      cause: error,
    });
  }
}

export function desiredState(config, reviewerIds = []) {
  const mergeMethods = new Set(config.repositorySettings.mergeMethods);
  const codeqlDefaultSetup = config.security.codeqlDefaultSetup ?? {};
  return {
    defaultBranch: config.defaultBranch,
    immutableReleases: true,
    repositorySettings: {
      wiki: config.repositorySettings.wiki,
      projects: config.repositorySettings.projects,
      squashMerge: mergeMethods.has("squash"),
      mergeCommit: mergeMethods.has("merge"),
      rebaseMerge: mergeMethods.has("rebase"),
      autoMerge: config.repositorySettings.autoMerge,
      deleteBranchOnMerge: config.repositorySettings.deleteBranchOnMerge,
      updateBranch: config.repositorySettings.updateBranch,
    },
    workflowPermissions: config.workflowPermissions,
    security: {
      dependabotAlerts: config.security.dependabotAlerts,
      dependabotSecurityUpdates: config.security.dependabotSecurityUpdates,
      dependabotSecurityUpdatesPaused: false,
      codeqlDefaultSetup: normalizeCodeqlDefaultSetup(
        codeqlDefaultSetupPayload(codeqlDefaultSetup),
      ),
    },
    mainRuleset: {
      name: config.mainRuleset.name,
      enforcement: "active",
      targetDefaultBranch: true,
      requiredChecks: [...config.mainRuleset.requiredChecks].sort(),
      strictStatusChecks: config.mainRuleset.requiredChecks.length > 0,
      allowBranchCreationWithoutChecks: false,
      requirePullRequest: true,
      allowedMergeMethods: [...config.mainRuleset.allowedMergeMethods].sort(),
      dismissStaleReviews: false,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requiredApprovals: 0,
      requireConversationResolution: true,
      blockForcePushes: true,
      blockDeletion: true,
    },
    releaseEnvironment: config.releaseEnvironment
      ? {
          ...config.releaseEnvironment,
          branches: [...config.releaseEnvironment.branches].sort(),
          reviewers: [...reviewerIds]
            .sort((left, right) => left - right)
            .map((id) => ({ type: "User", id })),
        }
      : null,
  };
}

export function normalizeRepositorySettings(repository) {
  return {
    wiki: repository.has_wiki,
    projects: repository.has_projects,
    squashMerge: repository.allow_squash_merge,
    mergeCommit: repository.allow_merge_commit,
    rebaseMerge: repository.allow_rebase_merge,
    autoMerge: repository.allow_auto_merge,
    deleteBranchOnMerge: repository.delete_branch_on_merge,
    updateBranch: repository.allow_update_branch,
  };
}

export function repositorySettingsPayload(control) {
  return {
    has_wiki: control.wiki,
    has_projects: control.projects,
    allow_squash_merge: control.squashMerge,
    allow_merge_commit: control.mergeCommit,
    allow_rebase_merge: control.rebaseMerge,
    allow_auto_merge: control.autoMerge,
    delete_branch_on_merge: control.deleteBranchOnMerge,
    allow_update_branch: control.updateBranch,
  };
}

export function normalizeDependabotSecurityUpdates(updates) {
  return {
    dependabotSecurityUpdates: Boolean(updates?.enabled && !updates.paused),
    dependabotSecurityUpdatesPaused: Boolean(updates?.paused),
  };
}

export function dependabotAlertsEnabled(api, repository) {
  return api.optional(`repos/${repository}/vulnerability-alerts`) !== null;
}

export function normalizeCodeqlDefaultSetup(setup) {
  const languages = new Set();
  for (const language of setup.languages ?? []) {
    if (
      language === "javascript" ||
      language === "typescript" ||
      language === "javascript-typescript"
    ) {
      languages.add("javascript-typescript");
    } else {
      languages.add(language);
    }
  }
  return {
    state: setup.state,
    languages: [...languages].sort(),
    querySuite: setup.query_suite ?? "default",
    threatModel: setup.threat_model ?? "remote",
    runnerType: setup.runner_type ?? "standard",
    runnerLabel: setup.runner_label ?? null,
  };
}

export function codeqlDefaultSetupPayload(control = {}) {
  return {
    state: control.state,
    languages: control.languages,
    query_suite: control.querySuite,
    threat_model: control.threatModel,
    runner_type: control.runnerType,
    runner_label: control.runnerLabel,
  };
}

export function normalizeMainRuleset(ruleset) {
  if (!ruleset) return null;
  const pullRequest = ruleset.rules.find((rule) => rule.type === "pull_request");
  const statusChecks = ruleset.rules.find((rule) => rule.type === "required_status_checks");
  const pullParameters = pullRequest?.parameters ?? {};
  const checkParameters = statusChecks?.parameters ?? {};
  return {
    name: ruleset.name,
    enforcement: ["active", "disabled", "evaluate"].includes(ruleset.enforcement)
      ? ruleset.enforcement
      : "disabled",
    targetDefaultBranch:
      ruleset.conditions?.ref_name?.include?.length === 1 &&
      ruleset.conditions.ref_name.include[0] === "~DEFAULT_BRANCH" &&
      (ruleset.conditions.ref_name.exclude?.length ?? 0) === 0,
    requiredChecks: (checkParameters.required_status_checks ?? [])
      .map((check) => check.context)
      .sort(),
    strictStatusChecks: Boolean(checkParameters.strict_required_status_checks_policy),
    allowBranchCreationWithoutChecks: Boolean(checkParameters.do_not_enforce_on_create),
    requirePullRequest: Boolean(pullRequest),
    allowedMergeMethods: [...(pullParameters.allowed_merge_methods ?? [])].sort(),
    dismissStaleReviews: Boolean(pullParameters.dismiss_stale_reviews_on_push),
    requireCodeOwnerReview: Boolean(pullParameters.require_code_owner_review),
    requireLastPushApproval: Boolean(pullParameters.require_last_push_approval),
    requiredApprovals: Number(pullParameters.required_approving_review_count ?? 0),
    requireConversationResolution: Boolean(pullParameters.required_review_thread_resolution),
    blockForcePushes: ruleset.rules.some((rule) => rule.type === "non_fast_forward"),
    blockDeletion: ruleset.rules.some((rule) => rule.type === "deletion"),
  };
}

export function mainRulesetPayload(control, enforcement = control.enforcement) {
  const rules = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        allowed_merge_methods: control.allowedMergeMethods,
        dismiss_stale_reviews_on_push: control.dismissStaleReviews,
        require_code_owner_review: control.requireCodeOwnerReview,
        require_last_push_approval: control.requireLastPushApproval,
        required_approving_review_count: control.requiredApprovals,
        required_review_thread_resolution: control.requireConversationResolution,
      },
    },
  ];
  if (control.requiredChecks.length > 0) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: control.allowBranchCreationWithoutChecks,
        required_status_checks: control.requiredChecks.map((context) => ({ context })),
        strict_required_status_checks_policy: control.strictStatusChecks,
      },
    });
  }
  return {
    name: control.name,
    target: "branch",
    enforcement,
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules,
  };
}

export function normalizeReleaseEnvironment(environment, policies, variables) {
  if (!environment) return null;
  const reviewRule = environment.protection_rules.find(
    (rule) => rule.type === "required_reviewers",
  );
  const waitRule = environment.protection_rules.find((rule) => rule.type === "wait_timer");
  return {
    name: environment.name,
    waitTimer: Number(waitRule?.wait_timer ?? 0),
    preventSelfReview: Boolean(reviewRule?.prevent_self_review),
    reviewers: (reviewRule?.reviewers ?? [])
      .map(({ type, reviewer }) => ({ type, id: reviewer.id }))
      .sort((left, right) => left.id - right.id),
    branches: policies.map((policy) => policy.name).sort(),
    customBranchesOnly: Boolean(
      environment.deployment_branch_policy?.custom_branch_policies &&
      !environment.deployment_branch_policy.protected_branches,
    ),
    guardValue: variables.find((variable) => variable.name === "RELEASE_GUARD")?.value ?? "",
  };
}

function drift(control, operation) {
  return { control, operation, status: "drift" };
}

export function planRepositoryControlChanges(current, desired) {
  const changes = [];
  if (current.defaultBranch !== desired.defaultBranch) {
    changes.push({
      control: "default-branch",
      operation: "manual",
      status: "manual",
      detail: `Expected ${desired.defaultBranch}, found ${current.defaultBranch}.`,
    });
  }
  if (current.immutableReleases !== desired.immutableReleases) {
    changes.push(drift("immutable-releases", "enable"));
  }
  if (!isDeepStrictEqual(current.repositorySettings, desired.repositorySettings)) {
    changes.push(drift("repository-settings", "update"));
  }
  if (!isDeepStrictEqual(current.workflowPermissions, desired.workflowPermissions)) {
    changes.push(drift("workflow-permissions", "update"));
  }
  if (current.security.dependabotAlerts !== desired.security.dependabotAlerts) {
    changes.push(
      drift("dependabot-alerts", desired.security.dependabotAlerts ? "enable" : "disable"),
    );
  }
  if (current.security.dependabotSecurityUpdatesPaused) {
    changes.push({
      control: "dependabot-security-updates",
      operation: "manual",
      status: "manual",
      detail: "Dependabot security updates are paused and require repository activity.",
    });
  } else if (
    current.security.dependabotSecurityUpdates !== desired.security.dependabotSecurityUpdates
  ) {
    changes.push(
      drift(
        "dependabot-security-updates",
        desired.security.dependabotSecurityUpdates ? "enable" : "disable",
      ),
    );
  }
  if (!current.security.codeqlSupported) {
    changes.push({
      control: "codeql-default-setup",
      operation: "unsupported",
      status: "unsupported",
      detail: current.security.codeqlDetail,
    });
  } else if (
    !isDeepStrictEqual(current.security.codeqlDefaultSetup, desired.security.codeqlDefaultSetup)
  ) {
    changes.push(drift("codeql-default-setup", "update"));
  }
  if (!current.rulesetsSupported) {
    changes.push({
      control: "main-ruleset",
      operation: "unsupported",
      status: "unsupported",
      detail: current.rulesetsDetail,
    });
  } else if (!isDeepStrictEqual(current.mainRuleset, desired.mainRuleset)) {
    changes.push(drift("main-ruleset", current.mainRuleset ? "update" : "create"));
  }
  if (!isDeepStrictEqual(current.releaseEnvironment, desired.releaseEnvironment)) {
    changes.push(drift("release-environment", current.releaseEnvironment ? "update" : "create"));
  }
  return changes;
}

export async function waitForCodeql(read, desired, options = {}) {
  const attempts = options.attempts ?? CODEQL_ATTEMPTS;
  const delayMs = options.delayMs ?? CODEQL_DELAY_MS;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isDeepStrictEqual(await read(), desired)) return;
    if (attempt < attempts) await delay(delayMs);
  }
  throw new Error("CodeQL default setup did not reach the desired state in time.");
}

function validateConfig(config) {
  if (config?.schemaVersion !== 1)
    throw new Error("Unsupported repository-controls schema version.");
  if (
    typeof config.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)
  ) {
    throw new Error("Repository controls must declare repository in owner/name format.");
  }
  if (
    !config.repositorySettings ||
    !config.security ||
    !config.mainRuleset ||
    !config.manualControls
  ) {
    throw new Error("Repository controls configuration is incomplete.");
  }
}

function resolveReviewers(api, config) {
  if (!config.releaseEnvironment) return [];
  return config.releaseEnvironment.reviewers.map((login) => {
    const reviewer = api.request("GET", `users/${login}`);
    if (reviewer.login.toLowerCase() !== login.toLowerCase()) {
      throw new Error(`Release reviewer ${login} could not be resolved.`);
    }
    return reviewer.id;
  });
}

export function readRepositoryControlState(api, repository, desired) {
  const repositorySettings = api.request("GET", `repos/${repository}`);
  const immutable = api.optional(`repos/${repository}/immutable-releases`);
  const workflow = api.request("GET", `repos/${repository}/actions/permissions/workflow`);
  const dependabotAlerts = dependabotAlertsEnabled(api, repository);
  const dependabotSecurityUpdates = api.optional(`repos/${repository}/automated-security-fixes`);
  const codeql = api.capability(`repos/${repository}/code-scanning/default-setup`);
  const rulesetsCapability = api.capability(`repos/${repository}/rulesets`, { paginate: true });
  const rulesets = rulesetsCapability.supported ? rulesetsCapability.value : [];
  const rulesetSummary = rulesets.find((candidate) => candidate.name === desired.mainRuleset.name);
  const ruleset = rulesetSummary
    ? api.request("GET", `repos/${repository}/rulesets/${rulesetSummary.id}`)
    : null;
  const environment = desired.releaseEnvironment
    ? api.optional(`repos/${repository}/environments/${desired.releaseEnvironment.name}`)
    : null;
  const policies = environment
    ? api.request(
        "GET",
        `repos/${repository}/environments/${environment.name}/deployment-branch-policies?per_page=100`,
      ).branch_policies
    : [];
  const variables = environment
    ? api.request(
        "GET",
        `repos/${repository}/environments/${environment.name}/variables?per_page=100`,
      ).variables
    : [];

  return {
    state: {
      defaultBranch: repositorySettings.default_branch,
      immutableReleases: Boolean(immutable?.enabled),
      repositorySettings: normalizeRepositorySettings(repositorySettings),
      workflowPermissions: {
        defaultWorkflowPermissions: workflow.default_workflow_permissions,
        canApprovePullRequestReviews: workflow.can_approve_pull_request_reviews,
      },
      security: {
        dependabotAlerts,
        ...normalizeDependabotSecurityUpdates(dependabotSecurityUpdates),
        codeqlSupported: codeql.supported,
        codeqlDefaultSetup: codeql.supported ? normalizeCodeqlDefaultSetup(codeql.value) : null,
        codeqlDetail: codeql.detail ?? null,
      },
      rulesetsSupported: rulesetsCapability.supported,
      rulesetsDetail: rulesetsCapability.detail ?? null,
      mainRuleset: normalizeMainRuleset(ruleset),
      releaseEnvironment: normalizeReleaseEnvironment(environment, policies, variables),
    },
    rulesetId: ruleset?.id ?? null,
  };
}

function printChanges(changes, log) {
  if (changes.length === 0) {
    log("Repository controls match the committed desired state.");
    return;
  }
  log("Repository-control findings:");
  for (const change of changes) {
    log(
      `- [${change.status}] ${change.operation} ${change.control}${change.detail ? `: ${change.detail}` : ""}`,
    );
  }
}

async function confirmApply() {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question("Apply these repository-control changes? [y/N] ")).trim() === "y";
  } finally {
    prompt.close();
  }
}

function applyReleaseEnvironment(api, repository, environment) {
  api.request("PUT", `repos/${repository}/environments/${environment.name}`, {
    wait_timer: environment.waitTimer,
    prevent_self_review: environment.preventSelfReview,
    reviewers: environment.reviewers,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: environment.customBranchesOnly,
    },
  });
  const policies =
    api.optional(
      `repos/${repository}/environments/${environment.name}/deployment-branch-policies?per_page=100`,
    )?.branch_policies ?? [];
  for (const branch of environment.branches) {
    if (!policies.some((policy) => policy.name === branch)) {
      api.request(
        "POST",
        `repos/${repository}/environments/${environment.name}/deployment-branch-policies`,
        { name: branch },
      );
    }
  }
  for (const policy of policies) {
    if (!environment.branches.includes(policy.name)) {
      api.request(
        "DELETE",
        `repos/${repository}/environments/${environment.name}/deployment-branch-policies/${policy.id}`,
      );
    }
  }
  const variables = api.request(
    "GET",
    `repos/${repository}/environments/${environment.name}/variables?per_page=100`,
  ).variables;
  const guard = variables.find((variable) => variable.name === "RELEASE_GUARD");
  const endpoint = `repos/${repository}/environments/${environment.name}/variables`;
  if (!guard) {
    api.request("POST", endpoint, { name: "RELEASE_GUARD", value: environment.guardValue });
  } else if (guard.value !== environment.guardValue) {
    api.request("PATCH", `${endpoint}/RELEASE_GUARD`, {
      name: "RELEASE_GUARD",
      value: environment.guardValue,
    });
  }
}

export async function runRepositoryControls(options = {}) {
  const apply = options.apply ?? process.argv.includes("--apply");
  const yes = options.yes ?? process.argv.includes("--yes");
  const api = options.api ?? new GitHubApi();
  const log = options.log ?? console.log;
  const config = options.config ?? readBoundedJson(configPath);
  validateConfig(config);

  if (!options.skipGhChecks) {
    run("gh", ["auth", "status"], { cwd: root, quiet: true });
    const resolved = run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: root },
    );
    if (resolved.toLowerCase() !== config.repository.toLowerCase()) {
      throw new Error(`Expected repository ${config.repository}, but gh resolved ${resolved}.`);
    }
  }

  const reviewerIds = resolveReviewers(api, config);
  const desired = desiredState(config, reviewerIds);
  const current = readRepositoryControlState(api, config.repository, desired);
  const changes = planRepositoryControlChanges(current.state, desired);
  printChanges(changes, log);
  if (config.manualControls.dependabotMalwareAlerts) {
    log(
      `Manual control: verify Dependabot malware alerts at https://github.com/${config.repository}/settings/security_analysis.`,
    );
  }
  if (config.manualControls.disableEnvironmentAdminBypass && config.releaseEnvironment) {
    log(
      `Manual control: disable administrator bypass for the ${config.releaseEnvironment.name} environment.`,
    );
  }

  if (!apply) return { ok: changes.length === 0, changes };
  const blockers = changes.filter(({ status }) => status !== "drift");
  if (blockers.length > 0) {
    throw new Error("Manual or unsupported repository controls must be resolved before apply.");
  }
  if (changes.length === 0) return { ok: true, changes: [] };
  if (!yes && !(await (options.confirmApply ?? confirmApply)())) {
    throw new Error("Repository-control changes were not applied.");
  }

  for (const change of changes) {
    if (change.control === "immutable-releases") {
      api.request("PUT", `repos/${config.repository}/immutable-releases`);
    } else if (change.control === "repository-settings") {
      api.request(
        "PATCH",
        `repos/${config.repository}`,
        repositorySettingsPayload(desired.repositorySettings),
      );
    } else if (change.control === "workflow-permissions") {
      api.request("PUT", `repos/${config.repository}/actions/permissions/workflow`, {
        default_workflow_permissions: desired.workflowPermissions.defaultWorkflowPermissions,
        can_approve_pull_request_reviews: desired.workflowPermissions.canApprovePullRequestReviews,
      });
    } else if (change.control === "dependabot-alerts") {
      api.request(
        change.operation === "enable" ? "PUT" : "DELETE",
        `repos/${config.repository}/vulnerability-alerts`,
      );
    } else if (change.control === "dependabot-security-updates") {
      api.request(
        change.operation === "enable" ? "PUT" : "DELETE",
        `repos/${config.repository}/automated-security-fixes`,
      );
    } else if (change.control === "codeql-default-setup") {
      api.request(
        "PATCH",
        `repos/${config.repository}/code-scanning/default-setup`,
        codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
      );
    } else if (change.control === "main-ruleset") {
      let rulesetId = current.rulesetId;
      if (rulesetId === null) {
        rulesetId = api.request(
          "POST",
          `repos/${config.repository}/rulesets`,
          mainRulesetPayload(desired.mainRuleset, "disabled"),
        ).id;
      }
      api.request(
        "PUT",
        `repos/${config.repository}/rulesets/${rulesetId}`,
        mainRulesetPayload(desired.mainRuleset),
      );
    } else if (change.control === "release-environment" && desired.releaseEnvironment) {
      applyReleaseEnvironment(api, config.repository, desired.releaseEnvironment);
    }
  }

  if (changes.some(({ control }) => control === "codeql-default-setup")) {
    await waitForCodeql(
      () =>
        normalizeCodeqlDefaultSetup(
          api.request("GET", `repos/${config.repository}/code-scanning/default-setup`),
        ),
      desired.security.codeqlDefaultSetup,
      options.polling,
    );
  }
  const remaining = planRepositoryControlChanges(
    readRepositoryControlState(api, config.repository, desired).state,
    desired,
  );
  if (remaining.length > 0) {
    throw new Error("Repository controls still differ after apply.");
  }
  log("Repository controls were applied and verified.");
  return { ok: true, changes };
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  runRepositoryControls()
    .then((result) => {
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "Repository-control operation failed.",
      );
      process.exitCode = 1;
    });
}
