// #844 and #846: github-repository-controls.defaultBranch gets its suggested value from the same
// rule as the guard's protectedBranch, the repository's default branch. compose_recipe reports it
// with its source, the dry run fills it in and reports it, apply_recipe refuses a recipe that does
// not record it, and the dry run warns when the two branches differ.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  githubRepositoryControlManagedFiles,
  normalizeGithubRepositoryControlsOptions,
} from "../src/github-repository-controls.js";
import {
  defaultBranchWarnings,
  describeIntegrationInputs,
  resolveIntegrationInputs,
} from "../src/integration-inputs.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, recipeToolDescriptions, validateRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { isolateGitConfiguration } from "./git-isolation.mjs";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";

// The default depends on init.defaultBranch, so no machine configuration may reach Git.
isolateGitConfiguration();

const path = "integrationOptions.github-repository-controls.defaultBranch";
const guard = "skill-protected-branch-guard";

/** @param {string[]} args */
function git(args) {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Calavera",
      "-c",
      "user.email=c@example.com",
    ].concat(args),
    { encoding: "utf8" },
  ).trim();
}

/**
 * Runs `callback` in a new Git repository that holds a package.json. `setup` shapes the
 * repository's branches before the callback runs.
 *
 * @param {() => void} setup
 * @param {(registry: ReturnType<typeof stubRegistry>) => Promise<void>} callback
 */
async function inProject(setup, callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-default-branch-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    git(["init", "--quiet", "--initial-branch=master"]);
    setup();
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    await callback(stubRegistry(new Map([[guard, "0.1.0"]])));
  } finally {
    process.chdir(originalDirectory);
  }
}

/** The only branch is master, as in the #749 run. */
function onlyMaster() {
  git(["commit", "--quiet", "--allow-empty", "-m", "scaffold"]);
}

/** No source answers: a feature branch checked out before the first commit. */
function noDefault() {
  git(["switch", "--quiet", "-c", "chore/calavera-setup"]);
}

/** @param {Record<string, unknown>} [options] */
function repositoryControls(options = {}) {
  return buildRecipe("minimal", ["github-repository-controls"], "npm", [], {
    "github-repository-controls": { repository: "octocat/example", ...options },
  });
}

test("the literal main fallback is gone: a recipe without defaultBranch does not gain one", () => {
  assert.equal(
    Object.hasOwn(
      normalizeGithubRepositoryControlsOptions({ repository: "octocat/example" }),
      "defaultBranch",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      repositoryControls().integrationOptions["github-repository-controls"],
      "defaultBranch",
    ),
    false,
  );
  // The release environment's branches default to defaultBranch once it is known.
  const release = { reviewers: ["octocat"] };
  assert.equal(
    normalizeGithubRepositoryControlsOptions({ repository: "o/r", releaseEnvironment: release })
      .releaseEnvironment.branches,
    undefined,
  );
  assert.deepEqual(
    normalizeGithubRepositoryControlsOptions({
      repository: "o/r",
      defaultBranch: "trunk",
      releaseEnvironment: release,
    }).releaseEnvironment.branches,
    ["trunk"],
  );
  // A caller that plans the files without filling defaultBranch first stops instead of writing a
  // configuration that describes no branch.
  assert.throws(
    () => githubRepositoryControlManagedFiles({ repository: "o/r" }),
    /integrationOptions\.github-repository-controls\.defaultBranch has no value/,
  );
  assert.throws(
    () => normalizeGithubRepositoryControlsOptions({ repository: "o/r", defaultBranch: " " }),
    /github-repository-controls\.defaultBranch must be a non-empty string/,
  );
});

test("Given a repository whose only branch is master, when compose_recipe composes github-repository-controls without defaultBranch, then it reports master as the default with its source", async () => {
  await inProject(onlyMaster, async () => {
    const response = await callMcpTool("compose_recipe", {
      profile: "minimal",
      packageManager: "npm",
      tools: ["github-repository-controls"],
      integrationOptions: { "github-repository-controls": { repository: "octocat/example" } },
    });

    assert.deepEqual(response.integrationInputs, [
      {
        integration: "github-repository-controls",
        name: "defaultBranch",
        path,
        prompt:
          "Which branch is the repository's default branch on GitHub, the branch pull requests merge into?",
        check: "branch-name",
        recorded: null,
        default: "master",
        defaultSource: {
          rule: "git-default-branch",
          detail:
            "git var GIT_DEFAULT_BRANCH names master, and the repository has a local branch master",
        },
        defaultUnavailable: null,
      },
    ]);
    assert.equal(
      Object.hasOwn(
        response.recipe.integrationOptions["github-repository-controls"],
        "defaultBranch",
      ),
      false,
    );
  });
});

test("Given a recipe without defaultBranch, when dry_run_apply runs, then result.recipe records master, the value is reported as the default with its source, and nothing is written", async () => {
  await inProject(onlyMaster, async () => {
    const before = await snapshot();
    const { result } = await callMcpTool("dry_run_apply", { recipe: repositoryControls() });

    assert.equal(
      result.recipe.integrationOptions["github-repository-controls"].defaultBranch,
      "master",
    );
    assert.deepEqual(result.integrationInputs, [
      {
        integration: "github-repository-controls",
        name: "defaultBranch",
        path,
        value: "master",
        source: "default",
        defaultSource: {
          rule: "git-default-branch",
          detail:
            "git var GIT_DEFAULT_BRANCH names master, and the repository has a local branch master",
        },
      },
    ]);
    assert.deepEqual(result.inputWarnings, []);
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given a recipe that records defaultBranch, when the dry run and apply run, then the recorded value is kept", async () => {
  await inProject(onlyMaster, async () => {
    const recipe = repositoryControls({ defaultBranch: "release" });
    const { result } = await callMcpTool("dry_run_apply", { recipe });
    assert.equal(
      result.recipe.integrationOptions["github-repository-controls"].defaultBranch,
      "release",
    );
    assert.equal(result.integrationInputs[0].source, "recorded");

    await callMcpTool("apply_recipe", { recipe: result.recipe, noInstall: true });
    const config = JSON.parse(await readFile(".github/repository-controls.json", "utf8"));
    assert.equal(config.defaultBranch, "release");
  });
});

test("Given a recipe without defaultBranch, when apply_recipe runs, then it stops before writing anything and names the option", async () => {
  await inProject(onlyMaster, async () => {
    const before = await snapshot();
    await assert.rejects(
      callMcpTool("apply_recipe", { recipe: repositoryControls(), noInstall: true }),
      /Calavera stopped before writing anything, because the recipe records no value for these integration inputs[\s\S]*- github-repository-controls needs defaultBranch; the dry run would use master\. Record it as integrationOptions\.github-repository-controls\.defaultBranch\./,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given no source for a default, when a non-interactive dry run runs a recipe without defaultBranch, then it stops and names the option", async () => {
  await inProject(noDefault, async () => {
    await assert.rejects(
      callMcpTool("dry_run_apply", { recipe: repositoryControls() }),
      /github-repository-controls needs the input defaultBranch .* Calavera has no default because no source names the repository's default branch: .* Record the value as integrationOptions\.github-repository-controls\.defaultBranch in the recipe/,
    );
    const response = await callMcpTool("compose_recipe", {
      profile: "minimal",
      tools: ["github-repository-controls"],
      integrationOptions: { "github-repository-controls": { repository: "octocat/example" } },
    });
    assert.equal(response.integrationInputs[0].default, null);
    assert.match(
      response.integrationInputs[0].defaultUnavailable,
      /^no source names the repository's default branch: /,
    );
  });
});

test("Given an interactive run, when defaultBranch is asked for, then the default is suggested, or nothing when there is none", async () => {
  await inProject(onlyMaster, async () => {
    const requests = [];
    const { recipe, inputs } = await resolveIntegrationInputs(
      validateRecipe(repositoryControls()),
      {
        ask: async (request) => {
          requests.push(request);
          return "trunk";
        },
      },
    );
    assert.deepEqual(requests, [
      {
        integration: "github-repository-controls",
        name: "defaultBranch",
        prompt:
          "Which branch is the repository's default branch on GitHub, the branch pull requests merge into?",
        defaultValue: "master",
        error: undefined,
      },
    ]);
    assert.equal(recipe.integrationOptions["github-repository-controls"].defaultBranch, "trunk");
    assert.equal(inputs[0].source, "prompt");
  });
  await inProject(noDefault, async () => {
    const requests = [];
    await resolveIntegrationInputs(validateRecipe(repositoryControls()), {
      ask: async (request) => {
        requests.push(request);
        return "main";
      },
    });
    assert.equal(requests[0].defaultValue, undefined);
  });
});

test("Given a recipe without github-repository-controls, then there are no integration inputs", async () => {
  await inProject(onlyMaster, async () => {
    const recipe = buildRecipe("minimal", ["editorconfig"], "npm");
    assert.deepEqual(await describeIntegrationInputs(recipe), []);
    assert.deepEqual(await resolveIntegrationInputs(recipe), { recipe, inputs: [] });
  });
});

test("Given a release environment without branches, when the dry run fills defaultBranch, then the release environment's branches follow it", async () => {
  await inProject(onlyMaster, async () => {
    const { result } = await callMcpTool("dry_run_apply", {
      recipe: repositoryControls({ releaseEnvironment: { reviewers: ["octocat"] } }),
    });
    assert.deepEqual(
      result.recipe.integrationOptions["github-repository-controls"].releaseEnvironment.branches,
      ["master"],
    );
  });
});

test("Given protectedBranch and defaultBranch that differ, when the dry run runs, then it warns and names both values, and the same branch gives no warning", async () => {
  await inProject(onlyMaster, async (registry) => {
    const recipe = {
      ...repositoryControls({ defaultBranch: "main" }),
      ai: [{ id: guard, inputs: { protectedBranch: "master" } }],
    };
    const { result } = await callMcpTool("dry_run_apply", { recipe }, registry);
    assert.deepEqual(result.inputWarnings, [
      `${guard} protects master (ai[0].inputs.protectedBranch), but github-repository-controls describes main to GitHub as the default branch (${path}). If both mean the branch pull requests merge into, record the same branch for both.`,
    ]);

    const { result: same } = await callMcpTool(
      "dry_run_apply",
      {
        recipe: {
          ...repositoryControls({ defaultBranch: "master" }),
          ai: [{ id: guard, inputs: { protectedBranch: "master" } }],
        },
      },
      registry,
    );
    assert.deepEqual(same.inputWarnings, []);
  });
});

test("Given a recipe without defaultBranch, when inspect_project runs, then it reports the missing value instead of stopping, and still inspects the other files", async () => {
  await inProject(onlyMaster, async () => {
    const recipe = buildRecipe(
      "minimal",
      ["editorconfig", "github-repository-controls"],
      "npm",
      [],
      {
        "github-repository-controls": { repository: "octocat/example" },
      },
    );
    await writeFile(".editorconfig", "root = true\n");
    const inspection = await callMcpTool("inspect_project", { recipe });

    assert.deepEqual(
      inspection.findings.filter(({ kind }) => kind === "unresolved-input"),
      [
        {
          severity: "info",
          kind: "unresolved-input",
          message: `The recipe records no ${path}, so inspection does not compare the github-repository-controls files. The dry run fills it from the repository's default branch and reports where the value came from.`,
        },
      ],
    );
    assert.ok(inspection.findings.some(({ path: file }) => file === ".editorconfig"));

    const recorded = await callMcpTool("inspect_project", {
      recipe: repositoryControls({ defaultBranch: "master" }),
    });
    assert.deepEqual(
      recorded.findings.filter(({ kind }) => kind === "unresolved-input"),
      [],
    );
  });
});

test("defaultBranchWarnings compares only a recorded input that suggests the repository's default branch", () => {
  const controls = { "github-repository-controls": { repository: "o/r", defaultBranch: "main" } };
  const declarations = {
    protectedBranch: { prompt: "p", default: "repository-default-branch", check: "branch-name" },
    releaseBranch: { prompt: "r", check: "branch-name" },
  };
  const declarationsFor = (/** @type {string} */ id) => (id === guard ? declarations : undefined);
  const warn = (recipe) => defaultBranchWarnings(recipe, { declarationsFor });

  // Nothing to compare: no options, or options without defaultBranch, or no artifacts.
  assert.deepEqual(warn({ ai: [{ id: guard, inputs: { protectedBranch: "master" } }] }), []);
  assert.deepEqual(
    warn({
      integrationOptions: { "github-repository-controls": { repository: "o/r" } },
      ai: [{ id: guard, inputs: { protectedBranch: "master" } }],
    }),
    [],
  );
  assert.deepEqual(warn({ integrationOptions: controls }), []);

  const warnings = warn({
    integrationOptions: controls,
    ai: [
      // A legacy item, an artifact without declarations, and one without a recorded value.
      { type: "skill", src: "skills/calavera" },
      { id: "skill-project-goal" },
      { id: guard },
      // An input whose default is not the repository's default branch.
      { id: guard, inputs: { releaseBranch: "release" } },
      { id: guard, inputs: { protectedBranch: "main" } },
      { id: guard, inputs: { protectedBranch: "master" } },
    ],
  });
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^skill-protected-branch-guard protects master \(ai\[5\]\.inputs\.protectedBranch\)/,
  );

  // Without declarationsFor, the catalog's declarations apply, and an unknown ID has none.
  assert.deepEqual(
    defaultBranchWarnings({
      integrationOptions: controls,
      ai: [{ id: "skill-unknown" }, { id: guard, inputs: { protectedBranch: "trunk" } }],
    }).length,
    1,
  );
});

// #877: an agent reads the tool list before it calls the tool, so the description has to name
// every field of the dry run that the agent must show to the person.
test("Given the dry_run_apply tool description, it names ignoreChanges and the files they change", () => {
  const description = recipeToolDescriptions.dry_run_apply;
  assert.match(description, /ignoreChanges/);
  assert.match(description, /\.gitignore/);
  assert.match(description, /\.htmlvalidateignore/);
});
