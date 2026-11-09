// Issue #846: the repository's default branch, the shared source of the suggested value for the
// guard's protectedBranch and for github-repository-controls.defaultBranch. One test per probe in
// the recommendation on #846. Each scratch repository runs Git with a global configuration file the
// test writes and without the system configuration, so the machine's init.defaultBranch cannot
// change the result.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveDefaultBranch } from "../src/utils/default-branch.js";
import { isolatedGitEnv } from "./git-isolation.mjs";

const execFileAsync = promisify(execFile);

/**
 * A scratch folder and a Git runner whose global configuration holds only `config`.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} [config]
 */
async function scratch(t, config = "") {
  const root = await mkdtemp(join(tmpdir(), "calavera-default-branch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalConfig = join(root, "gitconfig");
  await writeFile(globalConfig, config);
  const env = isolatedGitEnv(globalConfig);
  /** @param {string} cwd @param {string[]} args */
  const git = async (cwd, args) => {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Calavera",
        "-c",
        "user.email=c@example.com",
      ].concat(args),
      { cwd, env },
    );
    return stdout.trim();
  };
  /** @param {string} name */
  const init = async (name, args = []) => {
    const cwd = join(root, name);
    await execFileAsync("git", ["init", "--quiet", ...args, cwd], { env });
    return cwd;
  };
  /** @param {string} cwd */
  const commit = (cwd) => git(cwd, ["commit", "--quiet", "--allow-empty", "-m", "scaffold"]);
  /** @param {string} cwd */
  const resolve = (cwd) => resolveDefaultBranch(cwd, { env });
  return { root, env, git, init, commit, resolve };
}

test("Case 1: a fresh vp create --git repository on master with no commits defaults to master", async (t) => {
  const { init, resolve } = await scratch(t);
  const cwd = await init("fresh");

  assert.deepEqual(await resolve(cwd), {
    value: "master",
    source: "git-default-branch",
    detail:
      "git var GIT_DEFAULT_BRANCH names master, and the repository has no commits yet and is on master",
  });
});

test("Case 2: a fresh repository on a machine that sets init.defaultBranch=main defaults to main", async (t) => {
  const { init, resolve } = await scratch(t, "[init]\n\tdefaultBranch = main\n");
  const cwd = await init("fresh-main");

  assert.deepEqual(await resolve(cwd), {
    value: "main",
    source: "git-default-branch",
    detail:
      "git var GIT_DEFAULT_BRANCH names main, and the repository has no commits yet and is on main",
  });
});

test("Case 3: a scaffold committed on master, still on master, defaults to master", async (t) => {
  const { init, commit, resolve } = await scratch(t);
  const cwd = await init("committed");
  await commit(cwd);

  assert.deepEqual(await resolve(cwd), {
    value: "master",
    source: "git-default-branch",
    detail: "git var GIT_DEFAULT_BRANCH names master, and the repository has a local branch master",
  });
});

test("Case 4: in the documented flow, a feature branch checked out after the scaffold commit, the default is master and never the feature branch", async (t) => {
  const { init, commit, git, resolve } = await scratch(t);
  const cwd = await init("feature");
  await commit(cwd);
  await git(cwd, ["switch", "--quiet", "-c", "chore/calavera-setup"]);

  const result = await resolve(cwd);
  assert.equal(result.value, "master");
  assert.equal(result.source, "git-default-branch");
});

test("Case 5: a clone of a remote whose HEAD is main, on a machine whose default is master, defaults to the remote's main", async (t) => {
  const { root, init, commit, git, resolve } = await scratch(t);
  const source = await init("remote-main", ["--initial-branch=main"]);
  await commit(source);
  const clone = join(root, "clone");
  await git(root, ["clone", "--quiet", source, clone]);
  await git(clone, ["switch", "--quiet", "-c", "chore/calavera-setup"]);

  assert.deepEqual(await resolve(clone), {
    value: "main",
    source: "remote-default",
    detail: "refs/remotes/origin/HEAD points to origin/main",
  });
});

test("Case 6: after git push -u origin master to a new remote, the default is master before and after origin/HEAD exists", async (t) => {
  const { root, init, commit, git, resolve } = await scratch(t);
  const cwd = await init("pushed");
  await commit(cwd);
  await git(cwd, ["switch", "--quiet", "-c", "chore/calavera-setup"]);
  const remote = join(root, "remote.git");
  await git(root, ["init", "--quiet", "--bare", remote]);
  await git(cwd, ["remote", "add", "origin", remote]);
  await git(cwd, ["push", "--quiet", "-u", "origin", "master"]);

  // git push does not create refs/remotes/origin/HEAD, so the Git default answers.
  assert.equal((await resolve(cwd)).source, "git-default-branch");
  assert.equal((await resolve(cwd)).value, "master");

  await git(cwd, ["remote", "set-head", "origin", "--auto"]);
  assert.deepEqual(await resolve(cwd), {
    value: "master",
    source: "remote-default",
    detail: "refs/remotes/origin/HEAD points to origin/master",
  });
});

test("Case 7: a detached HEAD after one commit on master defaults to master", async (t) => {
  const { init, commit, git, resolve } = await scratch(t);
  const cwd = await init("detached");
  await commit(cwd);
  await git(cwd, ["switch", "--quiet", "--detach"]);

  assert.equal((await resolve(cwd)).value, "master");
});

test("Case 7b: a detached HEAD in a clone of a main remote, as CI checks out, defaults to main", async (t) => {
  const { root, init, commit, git, resolve } = await scratch(t);
  const source = await init("remote-main", ["--initial-branch=main"]);
  await commit(source);
  const clone = join(root, "clone");
  await git(root, ["clone", "--quiet", source, clone]);
  await git(clone, ["switch", "--quiet", "--detach"]);

  const result = await resolve(clone);
  assert.equal(result.value, "main");
  assert.equal(result.source, "remote-default");
});

test("Case 8: a feature branch checked out before the first commit gives no default, and the reason names each source", async (t) => {
  const { init, git, resolve } = await scratch(t);
  const cwd = await init("unborn-feature");
  await git(cwd, ["switch", "--quiet", "-c", "chore/calavera-setup"]);

  assert.deepEqual(await resolve(cwd), {
    reason:
      "no source names the repository's default branch: refs/remotes/origin/HEAD does not exist or is not a symbolic ref; git var GIT_DEFAULT_BRANCH names master, and the repository has no commits yet and is on chore/calavera-setup; the repository has no local branches",
  });
});

test("Case 9: a repository committed on master, with a feature branch checked out, on a machine later set to main, gives no default", async (t) => {
  const { init, commit, git, resolve } = await scratch(t, "[init]\n\tdefaultBranch = main\n");
  const cwd = await init("changed-machine", ["--initial-branch=master"]);
  await commit(cwd);
  await git(cwd, ["switch", "--quiet", "-c", "feat"]);

  assert.deepEqual(await resolve(cwd), {
    reason:
      "no source names the repository's default branch: refs/remotes/origin/HEAD does not exist or is not a symbolic ref; git var GIT_DEFAULT_BRANCH names main, and the repository has no local branch main; the repository has 2 local branches (feat, master), not exactly one",
  });
});

test("the only local branch answers when the Git default names a branch the repository does not have", async (t) => {
  const { init, commit, git, resolve } = await scratch(t);
  const cwd = await init("trunk", ["--initial-branch=trunk"]);
  await commit(cwd);
  await git(cwd, ["switch", "--quiet", "--detach"]);

  assert.deepEqual(await resolve(cwd), {
    value: "trunk",
    source: "only-local-branch",
    detail: "trunk is the repository's only local branch",
  });
});

test("the remote's default wins over the local evidence when they disagree", async (t) => {
  const { init, commit, git, resolve } = await scratch(t);
  const source = await init("remote-main", ["--initial-branch=main"]);
  await commit(source);
  const cwd = await init("local-master");
  await commit(cwd);
  await git(cwd, ["remote", "add", "origin", source]);
  await git(cwd, ["fetch", "--quiet", "origin"]);
  await git(cwd, ["remote", "set-head", "origin", "main"]);

  assert.equal((await resolve(cwd)).value, "main");
  assert.equal((await resolve(cwd)).source, "remote-default");
});

test("an origin/HEAD that points to a branch origin no longer has is skipped, and the next source answers", async (t) => {
  const { init, commit, git, resolve } = await scratch(t);
  const cwd = await init("dangling");
  await commit(cwd);
  await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone"]);

  assert.deepEqual(await resolve(cwd), {
    value: "master",
    source: "git-default-branch",
    detail: "git var GIT_DEFAULT_BRANCH names master, and the repository has a local branch master",
  });

  await git(cwd, ["switch", "--quiet", "-c", "feat"]);
  await git(cwd, ["branch", "--quiet", "-m", "master", "trunk"]);
  assert.match(
    (await resolve(cwd)).reason,
    /refs\/remotes\/origin\/HEAD points to refs\/remotes\/origin\/gone, which does not exist;/,
  );
});

test("an origin/HEAD that points outside origin's branches is not a remote default", async (t) => {
  const { init, commit, git, resolve } = await scratch(t, "[init]\n\tdefaultBranch = main\n");
  const cwd = await init("outside", ["--initial-branch=master"]);
  await commit(cwd);
  await git(cwd, ["branch", "feat"]);
  await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/feat"]);

  assert.match(
    (await resolve(cwd)).reason,
    /^no source names the repository's default branch: refs\/remotes\/origin\/HEAD points to refs\/heads\/feat, which is not a branch of origin;/,
  );
});

test("a corrupt origin/HEAD keeps Git's own error in the reason, distinct from having no default", async (t) => {
  const { init, commit, resolve } = await scratch(t);
  const cwd = await init("corrupt");
  await commit(cwd);
  await mkdir(join(cwd, ".git", "refs", "remotes", "origin"), { recursive: true });
  await writeFile(join(cwd, ".git", "refs", "remotes", "origin", "HEAD"), "garbage\n");

  // Git's standard error ends with a newline, which the reason leaves out.
  assert.deepEqual(await resolve(cwd), {
    reason:
      "git symbolic-ref --quiet refs/remotes/origin/HEAD failed: fatal: No such ref: refs/remotes/origin/HEAD",
  });
});

test("a directory outside Git keeps Git's own error in the reason", async (t) => {
  const { root, resolve } = await scratch(t);

  assert.match((await resolve(root)).reason, /failed: fatal: not a git repository/i);
});

test("without git on PATH the resolver throws the spawn error, so a caller can say Git is missing", async (t) => {
  const { init, env } = await scratch(t);
  const cwd = await init("no-git");

  await assert.rejects(resolveDefaultBranch(cwd, { env: { ...env, PATH: "" } }), {
    code: "ENOENT",
  });
});

test("a detached HEAD with no local branch gives no default, and the reason says HEAD is detached", async (t) => {
  const { init, commit, git, resolve } = await scratch(t);
  const cwd = await init("detached-no-branch");
  await commit(cwd);
  await git(cwd, ["switch", "--quiet", "--detach"]);
  await git(cwd, ["branch", "--quiet", "-D", "master"]);

  assert.deepEqual(await resolve(cwd), {
    reason:
      "no source names the repository's default branch: refs/remotes/origin/HEAD does not exist or is not a symbolic ref; git var GIT_DEFAULT_BRANCH names master, and the repository has no local branch and HEAD is detached; the repository has no local branches",
  });
});

test("origin's branches do not count as local branches", async (t) => {
  const { root, init, commit, git, resolve } = await scratch(t, "[init]\n\tdefaultBranch = main\n");
  const cwd = await init("tracking", ["--initial-branch=trunk"]);
  await commit(cwd);
  const remote = join(root, "remote.git");
  await git(root, ["init", "--quiet", "--bare", remote]);
  await git(cwd, ["remote", "add", "origin", remote]);
  await git(cwd, ["push", "--quiet", "origin", "trunk", "trunk:release"]);
  await git(cwd, ["fetch", "--quiet", "--no-auto-maintenance", "origin"]);
  await git(cwd, ["remote", "set-head", "origin", "--delete"]).catch(() => {});

  assert.deepEqual(await resolve(cwd), {
    value: "trunk",
    source: "only-local-branch",
    detail: "trunk is the repository's only local branch",
  });
});

/**
 * Puts a stand-in git first on PATH. It answers the one command `args` names with `stderr`, the
 * output `stdout`, and the exit code `code`, and passes every other command to the real Git, so a
 * test can make one step of the resolver fail.
 *
 * @param {import("node:test").TestContext} t
 * @param {NodeJS.ProcessEnv} env
 * @param {{ args: string, code: number, stderr?: string, stdout?: string }} answer
 */
async function standInGit(t, env, { args, code, stderr = "", stdout = "" }) {
  const { stdout: realGit } = await execFileAsync("git", ["--exec-path"], { env });
  const directory = await mkdtemp(join(tmpdir(), "calavera-stand-in-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "git");
  const quote = (/** @type {string} */ value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    script,
    [
      "#!/bin/sh",
      `if [ "$*" = ${quote(args)} ]; then`,
      `  printf '%s' ${quote(stdout)}`,
      `  printf '%s' ${quote(stderr)} >&2`,
      `  exit ${code}`,
      "fi",
      `exec ${quote(join(realGit.trim(), "git"))} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  return { ...env, PATH: `${directory}${delimiter}${env.PATH}` };
}

/** Two local branches, so no step before the last one answers on its own. */
async function twoBranches(t) {
  const context = await scratch(t, "[init]\n\tdefaultBranch = main\n");
  const cwd = await context.init("two", ["--initial-branch=master"]);
  await context.commit(cwd);
  await context.git(cwd, ["branch", "feat"]);
  return { ...context, cwd };
}

test("a failure in a later step keeps Git's error output, and the resolver stops there", async (t) => {
  for (const [args, reason] of [
    [
      "for-each-ref --format=%(refname) refs/heads/ refs/remotes/origin/",
      "git for-each-ref --format=%(refname) refs/heads/ refs/remotes/origin/ failed: fatal: refs unreadable",
    ],
  ]) {
    const { cwd, env } = await twoBranches(t);
    const failing = await standInGit(t, env, {
      args,
      code: 128,
      stderr: "fatal: refs unreadable\n",
    });
    assert.deepEqual(await resolveDefaultBranch(cwd, { env: failing }), { reason }, args);
  }

  const { init, env } = await scratch(t);
  const unborn = await init("unborn-head", ["--initial-branch=trunk"]);
  const failing = await standInGit(t, env, {
    args: "symbolic-ref --quiet HEAD",
    code: 128,
    stderr: "fatal: HEAD unreadable\n",
  });
  assert.deepEqual(await resolveDefaultBranch(unborn, { env: failing }), {
    reason: "git symbolic-ref --quiet HEAD failed: fatal: HEAD unreadable",
  });
});

test("only exit code 1 without output is a missing value; exit 1 with output, or another code, is a failure", async (t) => {
  const { cwd, env } = await twoBranches(t);
  const args = "symbolic-ref --quiet refs/remotes/origin/HEAD";

  const withOutput = await standInGit(t, env, { args, code: 1, stderr: "error: unexpected\n" });
  assert.deepEqual(await resolveDefaultBranch(cwd, { env: withOutput }), {
    reason: `git ${args} failed: error: unexpected`,
  });

  // Without standard error, the reason falls back to Node.js's description of the failure.
  const silent = await standInGit(t, env, { args, code: 2 });
  assert.match(
    (await resolveDefaultBranch(cwd, { env: silent })).reason,
    /^git symbolic-ref --quiet refs\/remotes\/origin\/HEAD failed: Command failed: git symbolic-ref --quiet refs\/remotes\/origin\/HEAD$/,
  );
});

test("git var GIT_DEFAULT_BRANCH without a value is noted, and the next source still answers", async (t) => {
  for (const answer of [{ code: 1 }, { code: 0 }]) {
    const { init, commit, env } = await scratch(t);
    const cwd = await init("no-git-default", ["--initial-branch=trunk"]);
    await commit(cwd);
    const silent = await standInGit(t, env, { args: "var GIT_DEFAULT_BRANCH", ...answer });
    assert.deepEqual(await resolveDefaultBranch(cwd, { env: silent }), {
      value: "trunk",
      source: "only-local-branch",
      detail: "trunk is the repository's only local branch",
    });

    const { cwd: two, env: twoEnv } = await twoBranches(t);
    const twoSilent = await standInGit(t, twoEnv, { args: "var GIT_DEFAULT_BRANCH", ...answer });
    assert.deepEqual(await resolveDefaultBranch(two, { env: twoSilent }), {
      reason:
        "no source names the repository's default branch: refs/remotes/origin/HEAD does not exist or is not a symbolic ref; git var GIT_DEFAULT_BRANCH has no value; the repository has 2 local branches (feat, master), not exactly one",
    });
  }
});

test("a Git release without GIT_DEFAULT_BRANCH skips that source: the only local branch still answers, and otherwise the reason keeps Git's output", async (t) => {
  // Before Git learned the variable, git var printed its usage and exited 129.
  const usage = {
    args: "var GIT_DEFAULT_BRANCH",
    code: 129,
    stderr: "usage: git var (-l | <variable>)\n",
  };
  const { init, commit, env } = await scratch(t);
  const cwd = await init("old-git", ["--initial-branch=master"]);
  await commit(cwd);
  assert.deepEqual(await resolveDefaultBranch(cwd, { env: await standInGit(t, env, usage) }), {
    value: "master",
    source: "only-local-branch",
    detail: "master is the repository's only local branch",
  });

  const { cwd: two, env: twoEnv } = await twoBranches(t);
  assert.deepEqual(await resolveDefaultBranch(two, { env: await standInGit(t, twoEnv, usage) }), {
    reason:
      "no source names the repository's default branch: refs/remotes/origin/HEAD does not exist or is not a symbolic ref; git var GIT_DEFAULT_BRANCH failed: usage: git var (-l | <variable>); the repository has 2 local branches (feat, master), not exactly one",
  });
});
