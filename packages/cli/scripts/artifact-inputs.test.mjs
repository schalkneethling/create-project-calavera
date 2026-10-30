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

const execFileAsync = promisify(execFile);

const declarations = {
  protectedBranch: {
    prompt: "Which branch should the guard protect?",
    default: "current-branch",
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

test("Given a repository on master and no recorded value, when apply runs without a prompt, then the current branch is used and reported as the default", async (t) => {
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
    },
  ]);
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

test("Given a detached HEAD and a non-interactive run, when inputs resolve, then apply stops and names protectedBranch", async (t) => {
  const cwd = await repository(t, "main");
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  await git(cwd, ["checkout", "--quiet", "--detach"]);

  await assert.rejects(
    resolveArtifactInputs(recipe({ id: "skill-protected-branch-guard" }), { cwd, declarationsFor }),
    /skill-protected-branch-guard needs the input protectedBranch .* HEAD is detached.* ai\[1\]\.inputs\.protectedBranch/,
  );
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
    /git symbolic-ref --short HEAD failed: .*not a git repository/i,
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

test("Given a recipe, when inputs are described for an agent, then each declared input shows its recorded value and default", async (t) => {
  const cwd = await repository(t, "trunk");

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
        defaultUnavailable: null,
      },
    ],
  );
  assert.deepEqual(
    await describeArtifactInputs({ ai: [{ id: "skill-project-goal" }] }, { cwd }),
    [],
  );
});
