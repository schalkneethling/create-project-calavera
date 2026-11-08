import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  checkInputValue,
  describeArtifactInputs,
  resolveArtifactInputs,
} from "../src/ai/artifact-inputs.js";
import { isolateGitConfiguration } from "./git-isolation.mjs";

const execFileAsync = promisify(execFile);
// #846: the default depends on init.defaultBranch, so no machine configuration may reach Git.
isolateGitConfiguration();

const declarations = {
  protectedBranch: {
    prompt: "Which branch should the guard protect?",
    default: "repository-default-branch",
    check: "branch-name",
  },
};
// No artifact in the catalog declares an input yet, so these tests supply the declaration that
// skill-protected-branch-guard will carry.
const declarationsFor = (id) => (id === "skill-protected-branch-guard" ? declarations : undefined);

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  await execFileAsync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Calavera",
      "-c",
      "user.email=c@example.com",
    ].concat(args),
    { cwd },
  );
}

/** @param {string} branch */
async function repository(t, branch) {
  const cwd = await mkdtemp(join(tmpdir(), "calavera-inputs-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, ["init", "--quiet", `--initial-branch=${branch}`]);
  return cwd;
}

function recipe(item) {
  return { version: 1, ai: [{ id: "skill-project-goal" }, item] };
}

test("Given a fresh repository on master and no recorded value, when apply runs without a prompt, then the repository's default branch is used and reported as the default with its source", async (t) => {
  const cwd = await repository(t, "master");
  const result = await resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
    cwd,
    declarationsFor,
  });

  assert.deepEqual(result.recipe.ai[1], {
    id: "skill-protected-branch-guard",
    inputs: { protectedBranch: "master" },
  });
  assert.deepEqual(result.recipe.ai[0], { id: "skill-project-goal" });
  assert.deepEqual(result.inputs, [
    {
      artifact: "skill-protected-branch-guard",
      index: 1,
      name: "protectedBranch",
      value: "master",
      source: "default",
      defaultSource: {
        rule: "git-default-branch",
        detail:
          "git var GIT_DEFAULT_BRANCH names master, and the repository has no commits yet and is on master",
      },
    },
  ]);
});

test("Given the documented flow, the scaffold committed on master and a feature branch checked out, when inputs are described and resolved, then the default is master and never the feature branch", async (t) => {
  const cwd = await repository(t, "master");
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", "scaffold"]);
  await git(cwd, ["switch", "--quiet", "-c", "chore/calavera-setup"]);

  const [described] = await describeArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
    cwd,
    declarationsFor,
  });
  assert.equal(described.default, "master");
  assert.equal(described.defaultSource.rule, "git-default-branch");

  const result = await resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
    cwd,
    declarationsFor,
  });
  assert.equal(result.recipe.ai[1].inputs.protectedBranch, "master");
});

test("Given a recorded value, when inputs resolve, then the recorded value is kept and nobody is asked", async (t) => {
  const cwd = await repository(t, "master");
  const result = await resolveArtifactInputs(
    recipe({ id: "skill-protected-branch-guard", inputs: { protectedBranch: "release/2.x" } }),
    {
      cwd,
      declarationsFor,
      ask: () => assert.fail("A recorded value must not be asked for again."),
    },
  );

  assert.equal(result.recipe.ai[1].inputs.protectedBranch, "release/2.x");
  assert.equal(result.inputs[0].source, "recorded");
});

test("Given an interactive run on branch master, when apply prompts, then the default is master and an invalid answer is asked again", async (t) => {
  const cwd = await repository(t, "master");
  const requests = [];
  const answers = ["main;rm", "main"];
  const result = await resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
    cwd,
    declarationsFor,
    ask: async (request) => {
      requests.push(request);
      return answers.shift();
    },
  });

  assert.equal(requests[0].defaultValue, "master");
  assert.equal(requests[0].prompt, declarations.protectedBranch.prompt);
  assert.equal(requests[0].error, undefined);
  assert.match(requests[1].error, /"main;rm" is not a branch name Calavera accepts/);
  assert.equal(result.recipe.ai[1].inputs.protectedBranch, "main");
  assert.equal(result.inputs[0].source, "prompt");
});

test("Given no source for a default and a non-interactive run, when inputs resolve, then apply stops, says why, and names protectedBranch", async (t) => {
  const cwd = await repository(t, "main");
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  await git(cwd, ["branch", "feat"]);
  await git(cwd, ["checkout", "--quiet", "--detach"]);

  await assert.rejects(
    resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), { cwd, declarationsFor }),
    /skill-protected-branch-guard needs the input protectedBranch .* no source names the repository's default branch: .* Record the value as ai\[1\]\.inputs\.protectedBranch/,
  );
});

test("Given no source for a default and an interactive run, when apply prompts, then nothing is suggested", async (t) => {
  const cwd = await repository(t, "main");
  await git(cwd, ["switch", "--quiet", "-c", "chore/calavera-setup"]);
  const requests = [];

  const result = await resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
    cwd,
    declarationsFor,
    ask: async (request) => {
      requests.push(request);
      return "main";
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].defaultValue, undefined);
  assert.equal(requests[0].artifact, "skill-protected-branch-guard");
  assert.equal(requests[0].index, 1);
  assert.equal(requests[0].name, "protectedBranch");
  assert.deepEqual(result.inputs[0], {
    artifact: "skill-protected-branch-guard",
    index: 1,
    name: "protectedBranch",
    value: "main",
    source: "prompt",
  });
});

test("Given a recorded value Git refuses, when inputs resolve, then apply stops and names the recipe entry", async (t) => {
  const cwd = await repository(t, "main");

  await assert.rejects(
    resolveArtifactInputs(
      recipe({ id: "skill-protected-branch-guard", inputs: { protectedBranch: "main..dev" } }),
      { cwd, declarationsFor },
    ),
    /ai\[1\]\.inputs\.protectedBranch.*git check-ref-format --branch refused it/,
  );
});

test("Given a directory outside Git, when inputs resolve without a prompt, then the stop keeps Git's own reason", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "calavera-inputs-no-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await assert.rejects(
    resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
      cwd,
      declarationsFor,
    }),
    /Calavera has no default because git symbolic-ref --quiet refs\/remotes\/origin\/HEAD failed: fatal: not a git repository/i,
  );
});

test("branch-name check refuses shell metacharacters, option-like names, and names Git rewrites", async (t) => {
  const cwd = await repository(t, "main");

  for (const value of ["main", "release/2.x", "feature_1", "123-topic"]) {
    assert.equal(await checkInputValue("branch-name", value, cwd), undefined, value);
  }
  for (const value of ["a;b", "$(id)", "a|b", "a b", "-main", "@{-1}", "main.lock", "a..b"]) {
    assert.match(await checkInputValue("branch-name", value, cwd), /^"/, value);
  }
});

test("Given a recipe, when inputs are described for an agent, then each declared input shows its recorded value, its default, and where the default came from", async (t) => {
  const cwd = await repository(t, "trunk");
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", "initial"]);

  assert.deepEqual(
    await describeArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
      cwd,
      declarationsFor,
    }),
    [
      {
        artifact: "skill-protected-branch-guard",
        index: 1,
        name: "protectedBranch",
        prompt: declarations.protectedBranch.prompt,
        check: "branch-name",
        recorded: null,
        default: "trunk",
        defaultSource: {
          rule: "only-local-branch",
          detail: "trunk is the repository's only local branch",
        },
        defaultUnavailable: null,
      },
    ],
  );
  const unborn = await repository(t, "trunk");
  const [described] = await describeArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), {
    cwd: unborn,
    declarationsFor,
  });
  assert.equal(described.default, null);
  assert.equal(described.defaultSource, null);
  assert.match(described.defaultUnavailable, /^no source names the repository's default branch: /);
  assert.deepEqual(
    await describeArtifactInputs({ ai: [{ id: "skill-project-goal" }] }, { cwd }),
    [],
  );
});

test("Given no git on PATH, when inputs resolve, then apply stops with a Git-is-missing error instead of refusing the branch name", async (t) => {
  const cwd = await repository(t, "main");
  const path = process.env.PATH;
  process.env.PATH = "";
  t.after(() => {
    process.env.PATH = path;
  });

  await assert.rejects(
    resolveArtifactInputs(
      recipe({ id: "skill-protected-branch-guard", inputs: { protectedBranch: "main" } }),
      { cwd, declarationsFor },
    ),
    (error) => {
      assert.match(error.message, /Calavera needs Git to check the input, and git was not found/);
      assert.equal(error.cause?.code, "ENOENT");
      return true;
    },
  );
  await assert.rejects(
    resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), { cwd, declarationsFor }),
    /Calavera needs Git to read the default, and git was not found/,
  );
});
