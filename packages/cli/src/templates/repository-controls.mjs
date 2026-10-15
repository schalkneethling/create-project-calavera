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
export const CODEQL_ATTEMPTS = 36;
export const CODEQL_DELAY_MS = 5_000;
const MAX_PAGES = 100;
// The languages API names that the published CodeQL extractors declare as
// `github_api_languages` in github/codeql. The c-cpp and java-kotlin extractors are not
// published there, so the presence of those languages is not checked. The actions extractor
// declares no names, because the languages API does not report workflow files.
const CODEQL_API_LANGUAGES = {
  csharp: ["C#"],
  go: ["Go"],
  "javascript-typescript": ["JavaScript", "TypeScript", "Vue", "HTML"],
  python: ["Python"],
  ruby: ["Ruby"],
  swift: ["Swift"],
};
// Dependabot security updates are available only when Dependabot alerts are enabled.
const APPLY_PREREQUISITES = { "dependabot-security-updates": "dependabot-alerts" };
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
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
      target: "branch",
      noBypassActors: true,
      codeScanning: config.mainRuleset.codeScanning ?? null,
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

function redactTokens(text) {
  return String(text).replace(GITHUB_TOKEN, "[redacted token]");
}

// Returns the reason a language is absent, or null when it is present.
function languagePresence(api, repository, ref, language, readLanguages) {
  if (language === "actions") {
    const workflows = api.optional(
      `repos/${repository}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
    );
    if (workflows === null) return `the ${ref} branch has no .github/workflows directory`;
    const files = Array.isArray(workflows) ? workflows : [workflows];
    return files.some(({ type, name }) => type === "file" && /\.ya?ml$/.test(name))
      ? null
      : `.github/workflows on the ${ref} branch has no .yml or .yaml workflow file`;
  }
  const names = CODEQL_API_LANGUAGES[language];
  if (!names) throw new Error("no published languages API mapping exists for it");
  const detected = readLanguages();
  if (names.some((name) => detected.has(name))) return null;
  const listed =
    names.length > 1 ? `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}` : names[0];
  return `GET repos/${repository}/languages reports no ${listed} code`;
}

// Compares the policy languages with what GitHub can analyze. Returns the missing languages,
// which block CodeQL default setup, and the languages whose presence is unknown.
function codeqlLanguagePresence(api, repository, ref, setup, desired) {
  const missing = [];
  const unknown = [];
  if (desired.state !== "configured") return { missing, unknown };
  if (setup.state === "not-configured") {
    // Observed, not documented: while default setup is not configured, GitHub returns the
    // languages it detects in the repository, and lists actions exactly when the default
    // branch has a .github/workflows directory.
    for (const language of desired.languages) {
      if (!setup.languages.includes(language)) {
        missing.push({ language, reason: "GitHub default setup does not detect it" });
      }
    }
    return { missing, unknown };
  }
  // Every language that default setup already analyzes is present.
  let detected;
  const readLanguages = () =>
    (detected ??= new Set(Object.keys(api.request("GET", `repos/${repository}/languages`) ?? {})));
  for (const language of desired.languages.filter((name) => !setup.languages.includes(name))) {
    try {
      const reason = languagePresence(api, repository, ref, language, readLanguages);
      if (reason) missing.push({ language, reason });
    } catch (error) {
      unknown.push({ language, reason: redactTokens(error.message) });
    }
  }
  return { missing, unknown };
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
    runnerLabel: setup.runner_label || null,
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

export function normalizeMainRuleset(ruleset, manageCodeScanning = true) {
  if (!ruleset) return null;
  const pullRequest = ruleset.rules.find((rule) => rule.type === "pull_request");
  const statusChecks = ruleset.rules.find((rule) => rule.type === "required_status_checks");
  const pullParameters = pullRequest?.parameters ?? {};
  const checkParameters = statusChecks?.parameters ?? {};
  return {
    name: ruleset.name,
    target: ruleset.target,
    noBypassActors: Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0,
    codeScanning: manageCodeScanning ? normalizeCodeScanning(ruleset) : null,
    enforcement: ["active", "disabled", "evaluate"].includes(ruleset.enforcement)
      ? ruleset.enforcement
      : "disabled",
    targetDefaultBranch:
      ruleset.conditions?.ref_name?.include?.length === 1 &&
      ruleset.conditions.ref_name.include[0] === "~DEFAULT_BRANCH" &&
      (ruleset.conditions.ref_name.exclude === undefined ||
        (Array.isArray(ruleset.conditions.ref_name.exclude) &&
          ruleset.conditions.ref_name.exclude.length === 0)),
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

function normalizeCodeScanning(ruleset) {
  const tools = ruleset.rules
    .filter(({ type }) => type === "code_scanning")
    .flatMap((rule) => rule.parameters?.code_scanning_tools ?? [])
    .filter(({ tool }) => tool === "CodeQL");
  if (tools.length !== 1) return null;
  return {
    alertsThreshold: tools[0].alerts_threshold,
    securityAlertsThreshold: tools[0].security_alerts_threshold,
  };
}

export function mainRulesetPayload(control, enforcement = control.enforcement, existing = null) {
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
  const managedTypes = new Set([
    "deletion",
    "non_fast_forward",
    "pull_request",
    "required_status_checks",
  ]);
  if (control.codeScanning) managedTypes.add("code_scanning");
  rules.push(...(existing?.rules ?? []).filter(({ type }) => !managedTypes.has(type)));
  if (control.codeScanning) {
    const otherTools = (existing?.rules ?? [])
      .filter(({ type }) => type === "code_scanning")
      .flatMap((rule) => rule.parameters?.code_scanning_tools ?? [])
      .filter(({ tool }) => tool !== "CodeQL");
    rules.push({
      type: "code_scanning",
      parameters: {
        code_scanning_tools: [
          ...otherTools,
          {
            tool: "CodeQL",
            alerts_threshold: control.codeScanning.alertsThreshold,
            security_alerts_threshold: control.codeScanning.securityAlertsThreshold,
          },
        ],
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
  } else {
    const missing = current.security.codeqlMissingLanguages ?? [];
    const notes = (current.security.codeqlUnknownLanguages ?? []).map(
      ({ language, reason }) => `Presence of ${language} could not be determined: ${reason}.`,
    );
    if (missing.length > 0) {
      const reasons = missing.map(({ language, reason }) => `${language}: ${reason}`).join("; ");
      const steps = missing.map(({ language }) =>
        language === "actions"
          ? "add a workflow file under .github/workflows/ or remove actions"
          : `add ${language} code or remove ${language}`,
      );
      changes.push({
        control: "codeql-default-setup",
        operation: "update",
        status: "blocked",
        detail: [
          `GitHub cannot analyze every policy language (${reasons}). If you pushed recently, wait and run the check again.`,
          ...notes,
        ].join(" "),
        remedy: `For each language, ${steps.join("; ")} from security.codeqlDefaultSetup.languages in .github/repository-controls.json. Then run the drift check again.`,
      });
    } else if (
      !isDeepStrictEqual(current.security.codeqlDefaultSetup, desired.security.codeqlDefaultSetup)
    ) {
      changes.push(
        notes.length > 0
          ? { ...drift("codeql-default-setup", "update"), detail: notes.join(" ") }
          : drift("codeql-default-setup", "update"),
      );
    }
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
  const scanning = config.mainRuleset.codeScanning;
  if (
    scanning != null &&
    (typeof scanning !== "object" ||
      Array.isArray(scanning) ||
      Object.keys(scanning).some(
        (key) => !["alertsThreshold", "securityAlertsThreshold"].includes(key),
      ) ||
      !["none", "errors", "errors_and_warnings", "all"].includes(scanning.alertsThreshold) ||
      !["none", "critical", "high_or_higher", "medium_or_higher", "all"].includes(
        scanning.securityAlertsThreshold,
      ))
  )
    throw new Error("Invalid mainRuleset.codeScanning thresholds.");
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
  const codeqlDefaultSetup = codeql.supported ? normalizeCodeqlDefaultSetup(codeql.value) : null;
  const codeqlLanguages = codeqlDefaultSetup
    ? codeqlLanguagePresence(
        api,
        repository,
        repositorySettings.default_branch,
        codeqlDefaultSetup,
        desired.security.codeqlDefaultSetup,
      )
    : { missing: [], unknown: [] };
  const rulesetsCapability = api.capability(`repos/${repository}/rulesets?includes_parents=false`, {
    paginate: true,
  });
  const rulesets = rulesetsCapability.supported ? rulesetsCapability.value : [];
  const matches = rulesets.filter(
    (candidate) => candidate.name === desired.mainRuleset.name && candidate.target === "branch",
  );
  if (matches.length > 1) throw new Error("Multiple repository rulesets match the managed name.");
  const rulesetSummary = matches[0];
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
        codeqlDefaultSetup,
        codeqlDetail: codeql.detail ?? null,
        codeqlMissingLanguages: codeqlLanguages.missing,
        codeqlUnknownLanguages: codeqlLanguages.unknown,
      },
      rulesetsSupported: rulesetsCapability.supported,
      rulesetsDetail: rulesetsCapability.detail ?? null,
      mainRuleset: normalizeMainRuleset(ruleset, Boolean(desired.mainRuleset.codeScanning)),
      releaseEnvironment: normalizeReleaseEnvironment(environment, policies, variables),
    },
    rulesetId: ruleset?.id ?? null,
    ruleset,
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
    if (change.remedy) log(`  What to do: ${change.remedy}`);
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

// The main ruleset is the most important protection, so it is applied first; applying it does
// not require any other change. CodeQL default setup is the change most likely to fail, so it is
// applied last. With mainRuleset.codeScanning set, the ruleset blocks merges until CodeQL
// results exist. The other changes keep the planned order.
export function applyOrder(changes) {
  const rank = ({ control }) =>
    control === "main-ruleset" ? 0 : control === "codeql-default-setup" ? 2 : 1;
  return [...changes].sort((left, right) => rank(left) - rank(right));
}

function applyMainRuleset(api, repository, desired, current) {
  if (current.rulesetId !== null) {
    api.request(
      "PUT",
      `repos/${repository}/rulesets/${current.rulesetId}`,
      mainRulesetPayload(desired.mainRuleset, desired.mainRuleset.enforcement, current.ruleset),
    );
    return;
  }
  const { id } = api.request(
    "POST",
    `repos/${repository}/rulesets`,
    mainRulesetPayload(desired.mainRuleset, "disabled"),
  );
  try {
    api.request(
      "PUT",
      `repos/${repository}/rulesets/${id}`,
      mainRulesetPayload(desired.mainRuleset, desired.mainRuleset.enforcement),
    );
  } catch (error) {
    const failure = new Error(
      `Ruleset ${id} was created disabled, but the update that enforces it failed: ${error.message}`,
      { cause: error },
    );
    failure.status = error.status;
    failure.remedy = `Run the apply again; it updates ruleset ${id} in place and enforces it.`;
    throw failure;
  }
}

function applyChange(api, repository, change, desired, current) {
  if (change.control === "immutable-releases") {
    api.request("PUT", `repos/${repository}/immutable-releases`);
  } else if (change.control === "repository-settings") {
    api.request(
      "PATCH",
      `repos/${repository}`,
      repositorySettingsPayload(desired.repositorySettings),
    );
  } else if (change.control === "workflow-permissions") {
    api.request("PUT", `repos/${repository}/actions/permissions/workflow`, {
      default_workflow_permissions: desired.workflowPermissions.defaultWorkflowPermissions,
      can_approve_pull_request_reviews: desired.workflowPermissions.canApprovePullRequestReviews,
    });
  } else if (change.control === "dependabot-alerts") {
    api.request(
      change.operation === "enable" ? "PUT" : "DELETE",
      `repos/${repository}/vulnerability-alerts`,
    );
  } else if (change.control === "dependabot-security-updates") {
    api.request(
      change.operation === "enable" ? "PUT" : "DELETE",
      `repos/${repository}/automated-security-fixes`,
    );
  } else if (change.control === "codeql-default-setup") {
    api.request(
      "PATCH",
      `repos/${repository}/code-scanning/default-setup`,
      codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
    );
  } else if (change.control === "main-ruleset") {
    applyMainRuleset(api, repository, desired, current);
  } else if (change.control === "release-environment" && desired.releaseEnvironment) {
    applyReleaseEnvironment(api, repository, desired.releaseEnvironment);
  }
}

function failureRemedy(change, error) {
  if (error?.remedy) return error.remedy;
  const status = error?.status;
  if (status === 401 || status === 403 || status === 404) {
    return "Check that the gh token can administer the repository (run gh auth status) and that the repository plan supports this control, then run the apply again.";
  }
  if (status === 422 && change.control === "codeql-default-setup") {
    return "If the error names a language, add code in that language or remove it from security.codeqlDefaultSetup.languages in .github/repository-controls.json. Then run the drift check again.";
  }
  if (status === 422) {
    return "Compare the error with .github/repository-controls.json, correct the policy or the repository, then run the drift check again.";
  }
  if (status === 429 || status >= 500) {
    return "GitHub is rate limiting or unavailable. Wait, then run the apply again.";
  }
  return "Run the drift check to see the current state, then run the apply again.";
}

function printApplySummary(outcomes, desired, log) {
  log("Repository-control apply summary:");
  for (const [heading, status, describe] of [
    ["Applied", "applied", () => ""],
    ["Failed", "failed", ({ error }) => `: ${redactTokens(error?.message ?? error)}`],
    ["Not attempted", "not-attempted", ({ reason }) => `: ${reason}`],
  ]) {
    log(`${heading}:`);
    const matching = outcomes.filter((outcome) => outcome.status === status);
    if (matching.length === 0) log("- none");
    for (const outcome of matching) {
      log(`- ${outcome.change.operation} ${outcome.change.control}${describe(outcome)}`);
      if (status !== "applied") log(`  What to do: ${outcome.remedy}`);
    }
  }
  const codeql = outcomes.find(({ change }) => change.control === "codeql-default-setup");
  if (codeql && codeql.status !== "applied" && desired.mainRuleset.codeScanning) {
    log(
      "Note: the main ruleset requires CodeQL results (mainRuleset.codeScanning), so it blocks merges until CodeQL default setup is configured and reports results.",
    );
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
  // Policy languages are required coverage, not a request to remove existing coverage. While
  // default setup is not configured, GitHub lists detected languages, which are not coverage.
  if (current.state.security.codeqlDefaultSetup?.state === "configured") {
    desired.security.codeqlDefaultSetup.languages = [
      ...new Set([
        ...desired.security.codeqlDefaultSetup.languages,
        ...current.state.security.codeqlDefaultSetup.languages,
      ]),
    ].sort();
  }
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
  const blockers = changes.filter(({ status }) => status === "manual" || status === "unsupported");
  if (blockers.length > 0) {
    throw new Error("Manual or unsupported repository controls must be resolved before apply.");
  }
  if (changes.length === 0) return { ok: true, changes: [] };
  if (
    changes.some(({ status }) => status === "drift") &&
    !yes &&
    !(await (options.confirmApply ?? confirmApply)())
  ) {
    throw new Error("Repository-control changes were not applied.");
  }

  const outcomes = [];
  const unresolved = new Set();
  for (const change of applyOrder(changes)) {
    const prerequisite = APPLY_PREREQUISITES[change.control];
    if (change.status === "blocked") {
      unresolved.add(change.control);
      outcomes.push({
        change,
        status: "not-attempted",
        reason: change.detail,
        remedy: change.remedy,
      });
    } else if (change.operation === "enable" && unresolved.has(prerequisite)) {
      unresolved.add(change.control);
      outcomes.push({
        change,
        status: "not-attempted",
        reason: `requires ${prerequisite}, which did not apply.`,
        remedy: `Resolve the ${prerequisite} failure, then run the apply again.`,
      });
    } else {
      try {
        applyChange(api, config.repository, change, desired, current);
        outcomes.push({ change, status: "applied" });
      } catch (error) {
        unresolved.add(change.control);
        outcomes.push({ change, status: "failed", error, remedy: failureRemedy(change, error) });
      }
    }
  }

  const codeql = outcomes.find(
    ({ change, status }) => change.control === "codeql-default-setup" && status === "applied",
  );
  if (codeql) {
    try {
      await waitForCodeql(
        () =>
          normalizeCodeqlDefaultSetup(
            api.request("GET", `repos/${config.repository}/code-scanning/default-setup`),
          ),
        desired.security.codeqlDefaultSetup,
        options.polling,
      );
    } catch (error) {
      Object.assign(codeql, {
        status: "failed",
        error,
        remedy:
          "CodeQL default setup can take several minutes to finish. Run the drift check again later.",
      });
    }
  }
  let remaining = [];
  let verificationError = null;
  try {
    remaining = planRepositoryControlChanges(
      readRepositoryControlState(api, config.repository, desired).state,
      desired,
    );
  } catch (error) {
    verificationError = error;
  }
  for (const outcome of outcomes) {
    if (
      outcome.status === "applied" &&
      remaining.some(({ control }) => control === outcome.change.control)
    ) {
      Object.assign(outcome, {
        status: "failed",
        error: new Error("GitHub still reports drift after the change was applied."),
        remedy:
          "Run the drift check again. If the control still differs, compare the repository settings with .github/repository-controls.json.",
      });
    }
  }
  const failed = outcomes.filter(({ status }) => status === "failed");
  const notAttempted = outcomes.filter(({ status }) => status === "not-attempted");
  const unplanned = remaining.filter(
    ({ control }) => !changes.some((change) => change.control === control),
  );
  if (
    failed.length === 0 &&
    notAttempted.length === 0 &&
    unplanned.length === 0 &&
    !verificationError
  ) {
    log("Repository controls were applied and verified.");
    return { ok: true, changes };
  }

  printApplySummary(outcomes, desired, log);
  const errors = failed.map(({ error }) => error);
  if (verificationError) {
    log(`Verification failed: ${redactTokens(verificationError.message)}`);
    log("  What to do: Run the drift check to see which changes took effect.");
    throw new Error(
      "Repository controls could not be verified after apply. See the apply summary.",
      { cause: new AggregateError([...errors, verificationError]) },
    );
  }
  if (unplanned.length > 0) {
    log("Drift that the apply did not plan:");
    printChanges(unplanned, log);
  }
  const counts = [`${failed.length} failed`, `${notAttempted.length} not attempted`];
  if (unplanned.length > 0) {
    counts.push(`${unplanned.length} unplanned ${unplanned.length === 1 ? "finding" : "findings"}`);
  }
  throw new Error(
    `Repository controls still differ after apply: ${counts.join(", ")}. See the apply summary.`,
    errors.length > 0 ? { cause: new AggregateError(errors) } : undefined,
  );
}

// Describes an error and its causes once each, without repeating text a parent already shows.
export function describeFailure(error) {
  const lines = [];
  const shown = [];
  const visited = new Set();
  const visit = (value, depth) => {
    if (visited.has(value)) return;
    visited.add(value);
    const text = redactTokens(value instanceof Error ? value.message : value);
    const fresh = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !shown.some((previous) => previous.includes(line)));
    fresh.forEach((line, index) => {
      lines.push(
        depth === 0 ? line : `${"  ".repeat(depth)}${index === 0 ? "Caused by: " : ""}${line}`,
      );
    });
    shown.push(text);
    if (value instanceof AggregateError) {
      for (const inner of value.errors) visit(inner, depth + 1);
    }
    if (value instanceof Error && value.cause !== undefined) visit(value.cause, depth + 1);
  };
  visit(error, 0);
  return lines.join("\n") || "Repository-control operation failed.";
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  runRepositoryControls()
    .then((result) => {
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(describeFailure(error));
      process.exitCode = 1;
    });
}
