import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  GitHubApi,
  dependabotAlertsEnabled,
  desiredState,
  codeqlDefaultSetupPayload,
  mainRulesetPayload,
  normalizeCodeqlDefaultSetup,
  normalizeDependabotSecurityUpdates,
  planRepositoryControlChanges,
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

test("CodeQL normalization tolerates omitted optional response fields", () => {
  assert.deepEqual(normalizeCodeqlDefaultSetup({ state: "not-configured" }), {
    state: "not-configured",
    languages: [],
    querySuite: "default",
    threatModel: "remote",
    runnerType: "standard",
    runnerLabel: null,
  });
});

test("CodeQL verification polling is bounded", async () => {
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
    capability(endpoint) {
      if (endpoint.endsWith("/code-scanning/default-setup")) {
        return {
          supported: true,
          value: codeqlDefaultSetupPayload(desired.security.codeqlDefaultSetup),
        };
      }
      if (endpoint.endsWith("/rulesets")) {
        return { supported: true, value: [{ id: 1, name: desired.mainRuleset.name }] };
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

test("Calavera apply manages repository-control files and scripts without contacting GitHub", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-repository-controls-"));
  const recipe = buildRecipe("minimal", ["github-repository-controls"], "npm", [], {
    "github-repository-controls": rawOptions,
  });
  try {
    process.chdir(projectDirectory);
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
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
