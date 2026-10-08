import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  createDependabotConfig,
  createRepositoryControlsConfig,
  githubRepositoryControlManagedFiles,
  normalizeGithubRepositoryControlsOptions,
} from "../src/github-repository-controls.js";
import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import {
  CODEQL_ATTEMPTS,
  CODEQL_DELAY_MS,
  GitHubApi,
  dependabotAlertsEnabled,
  desiredState,
  codeqlDefaultSetupPayload,
  mainRulesetPayload,
  normalizeCodeqlDefaultSetup,
  normalizeMainRuleset,
  normalizeDependabotSecurityUpdates,
  planRepositoryControlChanges,
  readRepositoryControlState,
  repositorySettingsPayload,
  runRepositoryControls,
  waitForCodeql,
} from "../src/templates/repository-controls.mjs";

const rawOptions = {
  repository: "octocat/example",
  requiredChecks: ["quality"],
  mergeMethods: ["merge", "rebase"],
  releaseEnvironment: {
    reviewers: ["octocat"],
  },
};

test("repository-control options normalize an explicit repository policy", () => {
  const options = normalizeGithubRepositoryControlsOptions(rawOptions);
  assert.equal(options.codeqlQuerySuite, "extended");
  assert.equal(
    normalizeGithubRepositoryControlsOptions({ ...rawOptions, codeqlQuerySuite: "default" })
      .codeqlQuerySuite,
    "default",
  );
  assert.deepEqual(options.mergeMethods, ["merge", "rebase"]);
  assert.deepEqual(options.dependabotEcosystems, ["npm", "github-actions"]);
  assert.deepEqual(options.codeqlLanguages, ["actions", "javascript-typescript"]);
  assert.deepEqual(options.releaseEnvironment, {
    name: "release",
    reviewers: ["octocat"],
    waitTimer: 0,
    preventSelfReview: false,
    branches: ["main"],
  });
  assert.throws(
    () => normalizeGithubRepositoryControlsOptions({ repository: "not-a-repository" }),
    /owner\/name/,
  );
  assert.throws(
    () =>
      normalizeGithubRepositoryControlsOptions({
        repository: "octocat/example",
        codeqlLanguages: [],
      }),
    /must not be empty/,
  );
  assert.throws(
    () =>
      normalizeGithubRepositoryControlsOptions({
        repository: "octocat/example",
        releaseEnvironment: { reviewers: ["octocat"], branches: [] },
      }),
    /branches must contain at least one branch/,
  );
});

test("generated Dependabot YAML contains semantic npm and Actions entries", () => {
  const configuration = parseYaml(createDependabotConfig(["npm", "github-actions"]));
  assert.equal(configuration.version, 2);
  assert.deepEqual(
    configuration.updates.map((update) => update["package-ecosystem"]),
    ["npm", "github-actions"],
  );
  assert.equal(
    configuration.updates.every((update) => update.directory === "/"),
    true,
  );
});

test("generated desired state keeps release protection optional", () => {
  const withoutRelease = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  assert.equal(withoutRelease.releaseEnvironment, null);
  assert.equal(withoutRelease.manualControls.disableEnvironmentAdminBypass, false);

  const withRelease = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions(rawOptions),
  );
  assert.equal(withRelease.releaseEnvironment.name, "release");
  assert.equal(withRelease.manualControls.disableEnvironmentAdminBypass, true);
});

test("generated repository-control documentation uses portable Node commands", () => {
  const documentation = githubRepositoryControlManagedFiles(rawOptions).find(
    ({ path }) => path === "docs/repository-controls.md",
  ).contents;

  assert.match(documentation, /node scripts\/repository-controls\.mjs\n/);
  assert.match(documentation, /node scripts\/repository-controls\.mjs --apply/);
  assert.doesNotMatch(documentation, /npm run repo:controls/);
  assert.match(documentation, /add `--yes` to the apply command/);
  const defaultSuiteDocs = githubRepositoryControlManagedFiles({
    ...rawOptions,
    codeqlQuerySuite: "default",
  }).find(({ path }) => path === "docs/repository-controls.md").contents;
  assert.match(defaultSuiteDocs, /uses the default query suite/);
});

test("README documents runnable check and confirmed apply package scripts", async () => {
  const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");

  assert.match(readme, /npm run repo:controls:check/);
  assert.match(readme, /npm run repo:controls:apply -- --yes/);
});

test("generated runtime handles 204 and 404 Dependabot alert responses", () => {
  const enabledApi = { optional: () => undefined };
  const disabledApi = { optional: () => null };
  assert.equal(dependabotAlertsEnabled(enabledApi, "octocat/example"), true);
  assert.equal(dependabotAlertsEnabled(disabledApi, "octocat/example"), false);
  assert.deepEqual(normalizeDependabotSecurityUpdates({ enabled: true, paused: true }), {
    dependabotSecurityUpdates: false,
    dependabotSecurityUpdatesPaused: true,
  });
});

test("GitHub API capability reads distinguish unsupported CodeQL", () => {
  const api = new GitHubApi();
  api.request = () => {
    const error = new Error("HTTP 403: GitHub Advanced Security is unavailable");
    error.status = 403;
    throw error;
  };
  assert.deepEqual(api.capability("repos/octocat/example/code-scanning/default-setup"), {
    supported: false,
    detail: "Error: HTTP 403: GitHub Advanced Security is unavailable",
  });
});

test("planner separates drift, manual remediation, and unsupported controls", () => {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  const desired = desiredState(config);
  const current = structuredClone(desired);
  current.immutableReleases = false;
  current.security.dependabotSecurityUpdates = false;
  current.security.dependabotSecurityUpdatesPaused = true;
  current.security.codeqlSupported = false;
  current.security.codeqlDetail = "GitHub Advanced Security is unavailable";
  current.rulesetsSupported = true;
  current.rulesetsDetail = null;

  assert.deepEqual(planRepositoryControlChanges(current, desired), [
    { control: "immutable-releases", operation: "enable", status: "drift" },
    {
      control: "dependabot-security-updates",
      operation: "manual",
      status: "manual",
      detail: "Dependabot security updates are paused and require repository activity.",
    },
    {
      control: "codeql-default-setup",
      operation: "unsupported",
      status: "unsupported",
      detail: "GitHub Advanced Security is unavailable",
    },
  ]);
});

test("CodeQL normalization tolerates omitted fields and empty runner labels", () => {
  assert.deepEqual(normalizeCodeqlDefaultSetup({ state: "not-configured" }), {
    state: "not-configured",
    languages: [],
    querySuite: "default",
    threatModel: "remote",
    runnerType: "standard",
    runnerLabel: null,
  });
  assert.deepEqual(normalizeCodeqlDefaultSetup({ state: "configured", runner_label: "" }), {
    state: "configured",
    languages: [],
    querySuite: "default",
    threatModel: "remote",
    runnerType: "standard",
    runnerLabel: null,
  });
});

test("desired CodeQL state normalizes omitted defaults like the GitHub response", () => {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  config.security.codeqlDefaultSetup = {
    state: "configured",
    languages: ["javascript-typescript"],
  };

  const desired = desiredState(config);
  assert.deepEqual(desired.security.codeqlDefaultSetup, {
    state: "configured",
    languages: ["javascript-typescript"],
    querySuite: "default",
    threatModel: "remote",
    runnerType: "standard",
    runnerLabel: null,
  });
  const current = structuredClone(desired);
  current.security.codeqlDefaultSetup = normalizeCodeqlDefaultSetup({
    ...codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
    runner_label: "",
  });
  current.security.codeqlSupported = true;
  current.rulesetsSupported = true;
  assert.deepEqual(planRepositoryControlChanges(current, desired), []);
});

test("planner derives both Dependabot operations from the desired state", () => {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  const desired = desiredState(config);
  desired.security.dependabotAlerts = false;
  desired.security.dependabotSecurityUpdates = false;
  const current = structuredClone(desired);
  current.security.dependabotAlerts = true;
  current.security.dependabotSecurityUpdates = true;
  current.security.dependabotSecurityUpdatesPaused = false;
  current.security.codeqlSupported = true;
  current.rulesetsSupported = true;

  assert.deepEqual(planRepositoryControlChanges(current, desired), [
    { control: "dependabot-alerts", operation: "disable", status: "drift" },
    { control: "dependabot-security-updates", operation: "disable", status: "drift" },
  ]);
});

test("GitHub API capability pagination retrieves rulesets after the first page", () => {
  const api = new GitHubApi();
  const endpoints = [];
  api.request = (method, endpoint) => {
    assert.equal(method, "GET");
    endpoints.push(endpoint);
    if (endpoint.endsWith("page=1")) {
      return Array.from({ length: 100 }, (_, id) => ({ id, name: `ruleset-${id}` }));
    }
    return [{ id: 101, name: "protect-default-branch" }];
  };

  const result = api.capability("repos/octocat/example/rulesets", { paginate: true });
  assert.equal(result.supported, true);
  assert.equal(result.value.length, 101);
  assert.equal(result.value.at(-1).name, "protect-default-branch");
  assert.deepEqual(endpoints, [
    "repos/octocat/example/rulesets?per_page=100&page=1",
    "repos/octocat/example/rulesets?per_page=100&page=2",
  ]);
});

test("repository-state reads update a matching ruleset returned after the first page", () => {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  const desired = desiredState(config);
  const api = {
    request(method, endpoint) {
      assert.equal(method, "GET");
      if (endpoint === "repos/octocat/example") {
        return {
          default_branch: "main",
          ...repositorySettingsPayload(desired.repositorySettings),
        };
      }
      if (endpoint.endsWith("/actions/permissions/workflow")) {
        return {
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        };
      }
      if (endpoint.endsWith("/rulesets/101")) {
        return { id: 101, ...mainRulesetPayload(desired.mainRuleset) };
      }
      throw new Error(`Unexpected GET: ${endpoint}`);
    },
    optional(endpoint) {
      if (endpoint.endsWith("/immutable-releases")) return { enabled: true };
      if (endpoint.endsWith("/vulnerability-alerts")) return undefined;
      if (endpoint.endsWith("/automated-security-fixes")) {
        return { enabled: true, paused: false };
      }
      throw new Error(`Unexpected optional GET: ${endpoint}`);
    },
    capability(endpoint, options) {
      if (endpoint.endsWith("/code-scanning/default-setup")) {
        return {
          supported: true,
          value: codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
        };
      }
      if (endpoint.endsWith("/rulesets?includes_parents=false")) {
        assert.deepEqual(options, { paginate: true });
        return {
          supported: true,
          value: [
            ...Array.from({ length: 100 }, (_, id) => ({ id, name: `ruleset-${id}` })),
            { id: 100, name: desired.mainRuleset.name, target: "tag" },
            { id: 101, name: desired.mainRuleset.name, target: "branch" },
          ],
        };
      }
      throw new Error(`Unexpected capability GET: ${endpoint}`);
    },
  };

  const current = readRepositoryControlState(api, config.repository, desired);
  assert.equal(current.rulesetId, 101);
  assert.deepEqual(current.state.mainRuleset, desired.mainRuleset);

  const capability = api.capability;
  let summaries = [{ id: 100, name: desired.mainRuleset.name, target: "tag" }];
  api.capability = (endpoint, options) =>
    endpoint.endsWith("/rulesets?includes_parents=false")
      ? { supported: true, value: summaries }
      : capability(endpoint, options);
  assert.equal(readRepositoryControlState(api, config.repository, desired).rulesetId, null);
  summaries = [101, 102].map((id) => ({ id, name: desired.mainRuleset.name, target: "branch" }));
  assert.throws(
    () => readRepositoryControlState(api, config.repository, desired),
    /Multiple repository rulesets/,
  );
});

test("CodeQL verification polling is bounded", async () => {
  assert.equal(CODEQL_ATTEMPTS, 36);
  assert.equal(CODEQL_DELAY_MS, 5_000);
  assert.equal((CODEQL_ATTEMPTS - 1) * CODEQL_DELAY_MS, 175_000);

  let reads = 0;
  await assert.rejects(
    () =>
      waitForCodeql(
        async () => {
          reads += 1;
          return { state: "not-configured" };
        },
        { state: "configured" },
        { attempts: 3, delayMs: 0, delay: async () => {} },
      ),
    /did not reach the desired state/,
  );
  assert.equal(reads, 3);
});

test("generated check stays read-only and apply mutates only planned drift", async () => {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  const desired = desiredState(config);
  let immutableEnabled = false;
  const mutations = [];
  const api = {
    request(method, endpoint, body) {
      if (method !== "GET") {
        mutations.push({ method, endpoint, body });
        if (method === "PUT" && endpoint.endsWith("/immutable-releases")) {
          immutableEnabled = true;
          return undefined;
        }
        throw new Error(`Unexpected mutation: ${method} ${endpoint}`);
      }
      if (endpoint === "repos/octocat/example") {
        return {
          default_branch: "main",
          ...repositorySettingsPayload(desired.repositorySettings),
        };
      }
      if (endpoint.endsWith("/actions/permissions/workflow")) {
        return {
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        };
      }
      if (endpoint === "repos/octocat/example/rulesets/1") {
        return { id: 1, ...mainRulesetPayload(desired.mainRuleset) };
      }
      throw new Error(`Unexpected GET: ${endpoint}`);
    },
    optional(endpoint) {
      if (endpoint.endsWith("/immutable-releases")) {
        return immutableEnabled ? { enabled: true } : null;
      }
      if (endpoint.endsWith("/vulnerability-alerts")) return undefined;
      if (endpoint.endsWith("/automated-security-fixes")) {
        return { enabled: true, paused: false };
      }
      throw new Error(`Unexpected optional GET: ${endpoint}`);
    },
    capability(endpoint, options) {
      if (endpoint.endsWith("/code-scanning/default-setup")) {
        return {
          supported: true,
          value: codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
        };
      }
      if (endpoint.endsWith("/rulesets?includes_parents=false")) {
        assert.deepEqual(options, { paginate: true });
        return {
          supported: true,
          value: [{ id: 1, name: desired.mainRuleset.name, target: "branch" }],
        };
      }
      throw new Error(`Unexpected capability GET: ${endpoint}`);
    },
  };
  const check = await runRepositoryControls({ api, config, skipGhChecks: true, log: () => {} });
  assert.equal(check.ok, false);
  assert.deepEqual(mutations, []);

  const apply = await runRepositoryControls({
    api,
    config,
    skipGhChecks: true,
    apply: true,
    yes: true,
    log: () => {},
  });
  assert.equal(apply.ok, true);
  assert.deepEqual(
    mutations.map(({ method, endpoint }) => ({ method, endpoint })),
    [{ method: "PUT", endpoint: "repos/octocat/example/immutable-releases" }],
  );
});

test("apply uses DELETE for planned Dependabot disable operations", async () => {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  config.security.dependabotAlerts = false;
  config.security.dependabotSecurityUpdates = false;
  const desired = desiredState(config);
  let alertsEnabled = true;
  let updatesEnabled = true;
  const mutations = [];
  const api = {
    request(method, endpoint, body) {
      if (method !== "GET") {
        mutations.push({ method, endpoint, body });
        if (method === "DELETE" && endpoint.endsWith("/vulnerability-alerts")) {
          alertsEnabled = false;
          return undefined;
        }
        if (method === "DELETE" && endpoint.endsWith("/automated-security-fixes")) {
          updatesEnabled = false;
          return undefined;
        }
        throw new Error(`Unexpected mutation: ${method} ${endpoint}`);
      }
      if (endpoint === "repos/octocat/example") {
        return {
          default_branch: "main",
          ...repositorySettingsPayload(desired.repositorySettings),
        };
      }
      if (endpoint.endsWith("/actions/permissions/workflow")) {
        return {
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        };
      }
      if (endpoint === "repos/octocat/example/rulesets/1") {
        return { id: 1, ...mainRulesetPayload(desired.mainRuleset) };
      }
      throw new Error(`Unexpected GET: ${endpoint}`);
    },
    optional(endpoint) {
      if (endpoint.endsWith("/immutable-releases")) return { enabled: true };
      if (endpoint.endsWith("/vulnerability-alerts")) {
        return alertsEnabled ? undefined : null;
      }
      if (endpoint.endsWith("/automated-security-fixes")) {
        return { enabled: updatesEnabled, paused: false };
      }
      throw new Error(`Unexpected optional GET: ${endpoint}`);
    },
    capability(endpoint) {
      if (endpoint.endsWith("/code-scanning/default-setup")) {
        return {
          supported: true,
          value: codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
        };
      }
      if (endpoint.endsWith("/rulesets?includes_parents=false")) {
        return {
          supported: true,
          value: [{ id: 1, name: desired.mainRuleset.name, target: "branch" }],
        };
      }
      throw new Error(`Unexpected capability GET: ${endpoint}`);
    },
  };

  const result = await runRepositoryControls({
    api,
    config,
    skipGhChecks: true,
    apply: true,
    yes: true,
    log: () => {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    mutations.map(({ method, endpoint }) => ({ method, endpoint })),
    [
      { method: "DELETE", endpoint: "repos/octocat/example/vulnerability-alerts" },
      { method: "DELETE", endpoint: "repos/octocat/example/automated-security-fixes" },
    ],
  );
});

test("runtime rejects incomplete configuration and malformed repository paths before API reads", async () => {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  const api = { request: () => assert.fail("API must not be called") };
  const withoutManualControls = structuredClone(config);
  delete withoutManualControls.manualControls;

  await assert.rejects(
    () => runRepositoryControls({ api, config: withoutManualControls, skipGhChecks: true }),
    /configuration is incomplete/,
  );
  await assert.rejects(
    () =>
      runRepositoryControls({
        api,
        config: { ...config, repository: "octocat/example/extra" },
        skipGhChecks: true,
      }),
    /owner\/name format/,
  );
});

test("Calavera apply manages repository-control files and scripts without contacting GitHub", async () => {
  const originalDirectory = process.cwd();
  await using projectDirectory = await mkdtempDisposable(
    join(tmpdir(), "calavera-repository-controls-"),
  );
  const recipe = buildRecipe("minimal", ["github-repository-controls"], "npm", [], {
    "github-repository-controls": rawOptions,
  });
  try {
    process.chdir(projectDirectory.path);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const dryRun = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });
    const expectedPaths = githubRepositoryControlManagedFiles(rawOptions).map(({ path }) => path);
    assert.deepEqual(
      dryRun.changes.filter(({ type }) => type === "write").map(({ path }) => path),
      expectedPaths,
    );

    await applyRecipeObject(recipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
    });
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(
      packageJson.scripts["repo:controls:check"],
      "node scripts/repository-controls.mjs",
    );
    assert.equal(
      packageJson.scripts["repo:controls:apply"],
      "node scripts/repository-controls.mjs --apply",
    );
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(
      state.managedFiles.filter(({ path }) => expectedPaths.includes(path)).map(({ path }) => path),
      expectedPaths,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("CodeQL protection detects weakened thresholds and ineffective rulesets", () => {
  const desired = desiredState(
    createRepositoryControlsConfig(
      normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
    ),
  );
  const baseline = mainRulesetPayload(desired.mainRuleset);
  assert.deepEqual(normalizeMainRuleset(baseline), desired.mainRuleset);
  assert.deepEqual(desired.mainRuleset.codeScanning, {
    alertsThreshold: "errors_and_warnings",
    securityAlertsThreshold: "medium_or_higher",
  });
  const mutations = [
    (rule) => {
      rule.rules = rule.rules.filter(({ type }) => type !== "code_scanning");
    },
    (rule) => {
      rule.rules.at(-1).parameters.code_scanning_tools[0].alerts_threshold = "errors";
    },
    (rule) => {
      rule.rules.at(-1).parameters.code_scanning_tools[0].security_alerts_threshold =
        "high_or_higher";
    },
    (rule) => {
      rule.enforcement = "evaluate";
    },
    (rule) => {
      rule.target = "tag";
    },
    (rule) => {
      rule.conditions.ref_name.include = ["refs/heads/develop"];
    },
    (rule) => {
      rule.conditions.ref_name.exclude = ["~DEFAULT_BRANCH"];
    },
    (rule) => {
      rule.conditions.ref_name.exclude = "";
    },
    (rule) => {
      delete rule.bypass_actors;
    },
    (rule) => {
      rule.bypass_actors = [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }];
    },
  ];
  for (const mutate of mutations) {
    const rule = structuredClone(baseline);
    mutate(rule);
    const current = structuredClone(desired);
    current.security.codeqlSupported = true;
    current.rulesetsSupported = true;
    current.mainRuleset = normalizeMainRuleset(rule);
    assert.deepEqual(planRepositoryControlChanges(current, desired), [
      { control: "main-ruleset", operation: "update", status: "drift" },
    ]);
  }
});

test("ruleset updates preserve unrelated rules and scanners idempotently", () => {
  const desired = desiredState(
    createRepositoryControlsConfig(
      normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
    ),
  );
  const existing = mainRulesetPayload(desired.mainRuleset);
  const other = { tool: "OtherScanner", alerts_threshold: "all", security_alerts_threshold: "all" };
  existing.rules.at(-1).parameters.code_scanning_tools.push(other);
  existing.rules.push({ type: "required_signatures" });
  const before = structuredClone(existing);
  const updated = mainRulesetPayload(desired.mainRuleset, "active", existing);
  assert.deepEqual(existing, before);
  assert.ok(updated.rules.some(({ type }) => type === "required_signatures"));
  assert.deepEqual(updated.rules.at(-1).parameters.code_scanning_tools[0], other);
  assert.deepEqual(mainRulesetPayload(desired.mainRuleset, "active", updated), updated);
  assert.deepEqual(normalizeMainRuleset(updated), desired.mainRuleset);

  delete desired.mainRuleset.codeScanning;
  const legacy = mainRulesetPayload(desired.mainRuleset, "active", existing);
  assert.deepEqual(
    legacy.rules.find(({ type }) => type === "code_scanning"),
    existing.rules.find(({ type }) => type === "code_scanning"),
  );
  assert.equal(normalizeMainRuleset(legacy, false).codeScanning, null);
});

test("invalid scanning policy fails before contacting GitHub", async () => {
  for (const codeScanning of [
    false,
    {},
    { alertsThreshold: "typo", securityAlertsThreshold: "all" },
  ]) {
    const config = createRepositoryControlsConfig(
      normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
    );
    config.mainRuleset.codeScanning = codeScanning;
    await assert.rejects(
      runRepositoryControls({
        config,
        skipGhChecks: true,
        api: { request: () => assert.fail("Unexpected API call") },
      }),
      /Invalid mainRuleset.codeScanning/,
    );
  }
});

test("apply repairs scanning drift and verifies the returned ruleset", async () => {
  for (const converge of [true, false]) {
    const config = createRepositoryControlsConfig(
      normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
    );
    const desired = desiredState(config);
    let ruleset = mainRulesetPayload(desired.mainRuleset);
    ruleset.rules = ruleset.rules.filter(({ type }) => type !== "code_scanning");
    ruleset.rules.push({ type: "required_signatures" });
    delete ruleset.conditions.ref_name.exclude;
    const writes = [];
    const api = {
      request(method, endpoint, body) {
        if (method === "PUT" && endpoint.endsWith("/rulesets/1")) {
          writes.push(body);
          if (converge) {
            ruleset = structuredClone(body);
            delete ruleset.conditions.ref_name.exclude;
          }
          return body;
        }
        assert.equal(method, "GET");
        if (endpoint.endsWith("/rulesets/1")) return { id: 1, ...ruleset };
        if (endpoint === "repos/octocat/example")
          return {
            default_branch: "main",
            ...repositorySettingsPayload(desired.repositorySettings),
          };
        if (endpoint.endsWith("/actions/permissions/workflow"))
          return { default_workflow_permissions: "read", can_approve_pull_request_reviews: false };
        assert.fail(`Unexpected request ${endpoint}`);
      },
      optional(endpoint) {
        if (endpoint.endsWith("/immutable-releases")) return { enabled: true };
        if (endpoint.endsWith("/vulnerability-alerts")) return undefined;
        if (endpoint.endsWith("/automated-security-fixes")) return { enabled: true, paused: false };
        assert.fail(`Unexpected optional ${endpoint}`);
      },
      capability(endpoint) {
        if (endpoint.endsWith("/code-scanning/default-setup"))
          return {
            supported: true,
            value: codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
          };
        if (endpoint.endsWith("/rulesets?includes_parents=false"))
          return {
            supported: true,
            value: [{ id: 1, name: desired.mainRuleset.name, target: "branch" }],
          };
        assert.fail(`Unexpected capability ${endpoint}`);
      },
    };
    const options = { config, api, skipGhChecks: true, log: () => {} };
    assert.equal((await runRepositoryControls(options)).ok, false);
    assert.deepEqual(writes, []);
    const apply = runRepositoryControls({ ...options, apply: true, yes: true });
    if (converge) {
      assert.equal((await apply).ok, true);
      assert.equal((await runRepositoryControls({ ...options, apply: true, yes: true })).ok, true);
    } else await assert.rejects(apply, /still differ after apply/);
    assert.equal(writes.length, 1);
    assert.ok(writes[0].rules.some(({ type }) => type === "required_signatures"));
  }
});

test("CodeQL apply preserves additional languages and verifies the merged coverage", async () => {
  for (const preserve of [true, false]) {
    const config = createRepositoryControlsConfig(
      normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
    );
    const original = structuredClone(config);
    const desired = desiredState(config);
    let setup = {
      ...codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
      languages: ["javascript", "typescript", "python"],
      query_suite: "default",
    };
    const writes = [];
    const api = {
      request(method, endpoint, body) {
        if (method === "PATCH" && endpoint.endsWith("/code-scanning/default-setup")) {
          writes.push(body);
          setup = structuredClone(body);
          if (!preserve)
            setup.languages = setup.languages.filter((language) => language !== "python");
          return {};
        }
        assert.equal(method, "GET");
        if (endpoint.endsWith("/code-scanning/default-setup")) return setup;
        if (endpoint.endsWith("/rulesets/1"))
          return { id: 1, ...mainRulesetPayload(desired.mainRuleset) };
        if (endpoint === "repos/octocat/example")
          return {
            default_branch: "main",
            ...repositorySettingsPayload(desired.repositorySettings),
          };
        if (endpoint.endsWith("/actions/permissions/workflow"))
          return { default_workflow_permissions: "read", can_approve_pull_request_reviews: false };
        if (endpoint.endsWith("/languages")) return { JavaScript: 10, Python: 5 };
        assert.fail(`Unexpected request ${endpoint}`);
      },
      optional(endpoint) {
        if (endpoint.endsWith("/immutable-releases")) return { enabled: true };
        if (endpoint.endsWith("/vulnerability-alerts")) return undefined;
        if (endpoint.endsWith("/automated-security-fixes")) return { enabled: true, paused: false };
        if (endpoint.endsWith("/git/trees/main?recursive=1"))
          return { truncated: false, tree: [{ path: ".github/workflows/ci.yml", type: "blob" }] };
        assert.fail(`Unexpected optional ${endpoint}`);
      },
      capability(endpoint) {
        if (endpoint.endsWith("/code-scanning/default-setup"))
          return { supported: true, value: setup };
        if (endpoint.endsWith("/rulesets?includes_parents=false"))
          return {
            supported: true,
            value: [{ id: 1, name: desired.mainRuleset.name, target: "branch" }],
          };
        assert.fail(`Unexpected capability ${endpoint}`);
      },
    };
    const lines = [];
    const options = {
      config,
      api,
      skipGhChecks: true,
      log: (line) => lines.push(line),
      polling: { attempts: 2, delayMs: 0, delay: async () => {} },
    };
    assert.deepEqual((await runRepositoryControls(options)).changes, [
      { control: "codeql-default-setup", operation: "update", status: "drift" },
    ]);
    assert.deepEqual(writes, []);
    const result = runRepositoryControls({ ...options, apply: true, yes: true });
    if (preserve) {
      assert.equal((await result).ok, true);
      assert.equal((await runRepositoryControls({ ...options, apply: true, yes: true })).ok, true);
    } else {
      await assert.rejects(result, /still differ after apply: 1 failed, 0 not attempted/);
      assert.ok(
        lines.includes(
          "- update codeql-default-setup: CodeQL default setup did not reach the desired state in time.",
        ),
      );
    }
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].languages, ["actions", "javascript-typescript", "python"]);
    assert.equal(writes[0].query_suite, "extended");
    assert.deepEqual(config, original);
  }
});

const CODEQL_422 =
  "GitHub API PATCH repos/octocat/example/code-scanning/default-setup failed: gh: One or more languages you selected are not present in the repository. (HTTP 422).";

function apiFailure(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// A new repository: every managed control differs from the policy, no ruleset exists, and
// CodeQL default setup is not configured.
function newRepository(desired, options = {}) {
  const state = {
    immutable: false,
    repository: {
      default_branch: "main",
      ...repositorySettingsPayload({
        ...desired.repositorySettings,
        wiki: !desired.repositorySettings.wiki,
      }),
    },
    alerts: false,
    updates: { enabled: false, paused: false },
    codeql: { state: "not-configured", languages: [] },
    ruleset: null,
  };
  const languages = options.languages ?? { JavaScript: 29192, TypeScript: 3463 };
  const tree = options.tree ?? {
    truncated: false,
    tree: [
      { path: ".github", type: "tree" },
      { path: ".github/workflows", type: "tree" },
      { path: ".github/workflows/ci.yml", type: "blob" },
      { path: "src/main.ts", type: "blob" },
    ],
  };
  const failures = options.failures ?? {};
  const mutations = [];
  const reads = [];
  const api = {
    request(method, endpoint, body) {
      if (method === "GET") {
        reads.push(endpoint);
        if (endpoint === "repos/octocat/example") return state.repository;
        if (endpoint.endsWith("/actions/permissions/workflow"))
          return { default_workflow_permissions: "read", can_approve_pull_request_reviews: false };
        if (endpoint === "repos/octocat/example/languages") return languages;
        if (endpoint.endsWith("/code-scanning/default-setup")) return state.codeql;
        if (endpoint === "repos/octocat/example/rulesets/7") return state.ruleset;
        assert.fail(`Unexpected GET ${endpoint}`);
      }
      const operation = `${method} ${endpoint}`;
      mutations.push(operation);
      if (failures[operation]) throw failures[operation];
      if (operation === "PUT repos/octocat/example/immutable-releases") state.immutable = true;
      else if (operation === "PATCH repos/octocat/example")
        state.repository = { ...state.repository, ...body };
      else if (operation === "PUT repos/octocat/example/vulnerability-alerts") state.alerts = true;
      else if (operation === "PUT repos/octocat/example/automated-security-fixes")
        state.updates = { enabled: true, paused: false };
      else if (operation === "PATCH repos/octocat/example/code-scanning/default-setup")
        state.codeql = structuredClone(body);
      else if (operation === "POST repos/octocat/example/rulesets") {
        state.ruleset = { id: 7, ...body };
        return { id: 7 };
      } else if (operation === "PUT repos/octocat/example/rulesets/7")
        state.ruleset = { id: 7, ...body };
      else assert.fail(`Unexpected mutation ${operation}`);
      return undefined;
    },
    optional(endpoint) {
      if (endpoint.endsWith("/immutable-releases"))
        return state.immutable ? { enabled: true } : null;
      if (endpoint.endsWith("/vulnerability-alerts")) return state.alerts ? undefined : null;
      if (endpoint.endsWith("/automated-security-fixes")) return state.updates;
      if (endpoint === "repos/octocat/example/git/trees/main?recursive=1") {
        reads.push(endpoint);
        // GitHubApi.optional returns null for a 404 and rethrows any other failure.
        if (tree instanceof Error && tree.status === 404) return null;
        if (tree instanceof Error) throw tree;
        return tree;
      }
      assert.fail(`Unexpected optional GET ${endpoint}`);
    },
    capability(endpoint) {
      if (endpoint.endsWith("/code-scanning/default-setup"))
        return { supported: true, value: state.codeql };
      if (endpoint.endsWith("/rulesets?includes_parents=false"))
        return {
          supported: true,
          value: state.ruleset ? [{ id: 7, name: desired.mainRuleset.name, target: "branch" }] : [],
        };
      assert.fail(`Unexpected capability GET ${endpoint}`);
    },
  };
  return { api, mutations, reads, state };
}

function newProjectOptions(api, lines) {
  const config = createRepositoryControlsConfig(
    normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
  );
  return {
    config,
    api,
    skipGhChecks: true,
    log: (line) => lines.push(line),
    polling: { attempts: 1, delayMs: 0, delay: async () => {} },
  };
}

function defaultDesiredState() {
  return desiredState(
    createRepositoryControlsConfig(
      normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
    ),
  );
}

test("drift check blocks CodeQL languages that GitHub does not detect before any change", async () => {
  const desired = defaultDesiredState();
  const { api, mutations } = newRepository(desired, {
    tree: { truncated: false, tree: [{ path: "src/main.ts", type: "blob" }] },
    languages: { CSS: 120 },
  });
  const lines = [];
  const options = newProjectOptions(api, lines);

  const check = await runRepositoryControls(options);
  assert.equal(check.ok, false);
  const codeql = check.changes.find(({ control }) => control === "codeql-default-setup");
  assert.equal(codeql.status, "blocked");
  assert.match(codeql.detail, /actions: .*no GitHub Actions workflow/);
  assert.match(codeql.detail, /\.github\/workflows/);
  assert.match(
    codeql.detail,
    /javascript-typescript: GET repos\/octocat\/example\/languages reports no JavaScript, TypeScript, Vue, or HTML code/,
  );
  assert.ok(lines.some((line) => line.startsWith("- [blocked] update codeql-default-setup: ")));

  await assert.rejects(
    runRepositoryControls({ ...options, apply: true, yes: true }),
    /Blocked, manual, or unsupported repository controls must be resolved before apply/,
  );
  assert.deepEqual(mutations, []);
});

test("CodeQL language presence follows the extractor file and languages API mappings", async () => {
  const desired = defaultDesiredState();
  const codeqlStatus = async (repository) =>
    (await runRepositoryControls(newProjectOptions(repository.api, []))).changes.find(
      ({ control }) => control === "codeql-default-setup",
    );

  for (const path of [
    ".github/workflows/ci.yaml",
    ".github/reusable_workflows/octo/repo/build.yml",
    "action.yml",
    "actions/setup/action.yaml",
  ]) {
    const repository = newRepository(desired, {
      tree: { truncated: false, tree: [{ path, type: "blob" }] },
      languages: { HTML: 10 },
    });
    assert.deepEqual(await codeqlStatus(repository), {
      control: "codeql-default-setup",
      operation: "update",
      status: "drift",
    });
  }

  for (const path of [".github/workflows/nested/ci.yml", ".github/workflows/README.md"]) {
    const repository = newRepository(desired, {
      tree: { truncated: false, tree: [{ path, type: "blob" }] },
    });
    assert.equal((await codeqlStatus(repository)).status, "blocked");
  }

  // A truncated tree or an unreadable ref cannot prove absence, so neither is a blocker.
  for (const tree of [
    { truncated: true, tree: [{ path: "src/main.ts", type: "blob" }] },
    apiFailure("GitHub API GET failed: Not Found (HTTP 404).", 404),
  ]) {
    assert.equal((await codeqlStatus(newRepository(desired, { tree }))).status, "drift");
  }

  // An empty repository has no files on any branch.
  const empty = newRepository(desired, {
    tree: apiFailure("GitHub API GET failed: Git Repository is empty. (HTTP 409).", 409),
    languages: {},
  });
  assert.equal((await codeqlStatus(empty)).status, "blocked");

  // Languages that are already configured remotely need no presence check.
  const configured = newRepository(desired, {
    tree: { truncated: false, tree: [] },
    languages: {},
  });
  configured.state.codeql = {
    state: "configured",
    languages: ["actions", "javascript", "typescript"],
    query_suite: "default",
  };
  assert.equal((await codeqlStatus(configured)).status, "drift");
  assert.equal(
    configured.reads.some((endpoint) => endpoint.endsWith("/languages")),
    false,
  );
});

test("apply runs the main ruleset first, continues after a CodeQL 422, and summarizes", async () => {
  const desired = defaultDesiredState();
  const { api, mutations } = newRepository(desired, {
    failures: {
      "PATCH repos/octocat/example/code-scanning/default-setup": apiFailure(CODEQL_422, 422),
    },
  });
  const lines = [];
  const options = newProjectOptions(api, lines);
  assert.deepEqual(
    (await runRepositoryControls(options)).changes.map(({ control, status }) => [control, status]),
    [
      ["immutable-releases", "drift"],
      ["repository-settings", "drift"],
      ["dependabot-alerts", "drift"],
      ["dependabot-security-updates", "drift"],
      ["codeql-default-setup", "drift"],
      ["main-ruleset", "drift"],
    ],
  );
  lines.length = 0;

  const error = await runRepositoryControls({ ...options, apply: true, yes: true }).then(
    () => assert.fail("Apply must fail when a change fails."),
    (failure) => failure,
  );
  assert.match(error.message, /still differ after apply: 1 failed, 0 not attempted/);
  assert.ok(error.cause instanceof AggregateError);
  assert.equal(error.cause.errors[0].status, 422);
  assert.deepEqual(mutations, [
    "POST repos/octocat/example/rulesets",
    "PUT repos/octocat/example/rulesets/7",
    "PUT repos/octocat/example/immutable-releases",
    "PATCH repos/octocat/example",
    "PUT repos/octocat/example/vulnerability-alerts",
    "PUT repos/octocat/example/automated-security-fixes",
    "PATCH repos/octocat/example/code-scanning/default-setup",
  ]);
  assert.deepEqual(lines.slice(lines.indexOf("Repository-control apply summary:")), [
    "Repository-control apply summary:",
    "Applied:",
    "- create main-ruleset",
    "- enable immutable-releases",
    "- update repository-settings",
    "- enable dependabot-alerts",
    "- enable dependabot-security-updates",
    "Failed:",
    `- update codeql-default-setup: ${CODEQL_422}`,
    "Not attempted:",
    "- none",
  ]);

  // The drift check now reports only the failed change.
  assert.deepEqual(
    (await runRepositoryControls(options)).changes.map(({ control }) => control),
    ["codeql-default-setup"],
  );
});

test("apply does not attempt a change whose prerequisite failed", async () => {
  const desired = defaultDesiredState();
  const alertsFailure = apiFailure(
    "GitHub API PUT repos/octocat/example/vulnerability-alerts failed: gh: Forbidden (HTTP 403).",
    403,
  );
  const { api, mutations } = newRepository(desired, {
    failures: { "PUT repos/octocat/example/vulnerability-alerts": alertsFailure },
  });
  const lines = [];

  await assert.rejects(
    runRepositoryControls({ ...newProjectOptions(api, lines), apply: true, yes: true }),
    (error) => {
      assert.match(error.message, /still differ after apply: 1 failed, 1 not attempted/);
      assert.deepEqual(error.cause.errors, [alertsFailure]);
      return true;
    },
  );
  assert.equal(mutations.includes("PUT repos/octocat/example/automated-security-fixes"), false);
  assert.ok(mutations.includes("PATCH repos/octocat/example/code-scanning/default-setup"));
  assert.deepEqual(lines.slice(lines.indexOf("Repository-control apply summary:")), [
    "Repository-control apply summary:",
    "Applied:",
    "- create main-ruleset",
    "- enable immutable-releases",
    "- update repository-settings",
    "- update codeql-default-setup",
    "Failed:",
    `- enable dependabot-alerts: ${alertsFailure.message}`,
    "Not attempted:",
    "- enable dependabot-security-updates: requires dependabot-alerts, which did not apply.",
  ]);
});

test("apply summarizes the outcome when verification cannot read GitHub", async () => {
  const desired = defaultDesiredState();
  const { api, mutations } = newRepository(desired);
  const outage = apiFailure("GitHub API GET repos/octocat/example failed: (HTTP 502).", 502);
  const request = api.request;
  let repositoryReads = 0;
  api.request = (method, endpoint, body) => {
    if (method === "GET" && endpoint === "repos/octocat/example" && ++repositoryReads > 1) {
      throw outage;
    }
    return request(method, endpoint, body);
  };
  const lines = [];

  await assert.rejects(
    runRepositoryControls({ ...newProjectOptions(api, lines), apply: true, yes: true }),
    (error) => {
      assert.match(error.message, /could not be verified after apply/);
      assert.deepEqual(error.cause.errors, [outage]);
      return true;
    },
  );
  assert.equal(mutations.length, 7);
  assert.ok(lines.includes("- update codeql-default-setup"));
  assert.equal(lines.at(-1), `Verification failed: ${outage.message}`);
});

test("a fully successful apply prints no failure summary", async () => {
  const desired = defaultDesiredState();
  const { api } = newRepository(desired);
  const lines = [];
  const result = await runRepositoryControls({
    ...newProjectOptions(api, lines),
    apply: true,
    yes: true,
  });
  assert.equal(result.ok, true);
  assert.equal(lines.includes("Repository-control apply summary:"), false);
  assert.equal(lines.at(-1), "Repository controls were applied and verified.");
});
