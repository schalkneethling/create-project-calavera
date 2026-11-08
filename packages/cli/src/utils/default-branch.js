// @ts-check
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ORIGIN_BRANCHES = "refs/remotes/origin/";
const LOCAL_BRANCHES = "refs/heads/";

/**
 * @typedef {"remote-default" | "git-default-branch" | "only-local-branch"} DefaultBranchSource
 *
 * @typedef {object} DefaultBranch
 * @property {string} value The branch name, without a refs/ or origin/ prefix.
 * @property {DefaultBranchSource} source Which rule answered.
 * @property {string} detail What Git showed that rule, for a person to check.
 *
 * @typedef {{ reason: string }} NoDefaultBranch Why there is no default. A reason that starts
 *   with "git " is a Git failure and keeps Git's own error output; any other reason means that no
 *   source names a branch.
 */

/**
 * Runs Git and tells a missing value apart from a failure. With --quiet, `git symbolic-ref` exits 1
 * and prints nothing when the ref does not exist or is not symbolic, and `git var` exits 1 when the
 * variable has no value. Any other exit is a failure that keeps Git's standard error.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ stdout: string } | { missing: true } | { failure: string }>}
 */
async function git(args, cwd, env) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, env });
    return { stdout: stdout.trim() };
  } catch (error) {
    const { code, stderr } = /** @type {{ code?: unknown, stderr?: unknown }} */ (error);
    // The caller says that Git is missing; it must not read as a branch without a default.
    if (code === "ENOENT") throw error;
    const output = typeof stderr === "string" ? stderr.trim() : "";
    if (code === 1 && !output) return { missing: true };
    const message = output || (error instanceof Error ? error.message : String(error));
    return { failure: `git ${args.join(" ")} failed: ${message}` };
  }
}

/** @param {string} ref */
function branchName(ref) {
  return ref.startsWith(LOCAL_BRANCHES) ? ref.slice(LOCAL_BRANCHES.length) : ref;
}

/**
 * The repository's default branch (ADR-0015, Decision 6, as amended on 2026-11-08). It is the
 * first of these that answers, and never the current branch:
 *
 * 1. The branch `refs/remotes/origin/HEAD` points to, when origin has that branch.
 * 2. The branch `git var GIT_DEFAULT_BRANCH` names, when the repository has a local branch of that
 *    name, or has no commits yet and HEAD names that branch.
 * 3. The repository's only local branch.
 *
 * Otherwise there is no default, and the reason names what each source showed.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<DefaultBranch | NoDefaultBranch>}
 */
export async function resolveDefaultBranch(cwd, { env = process.env } = {}) {
  const originHead = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd, env);
  if ("failure" in originHead) return { reason: originHead.failure };
  const refs = await git(
    ["for-each-ref", "--format=%(refname)", LOCAL_BRANCHES, ORIGIN_BRANCHES],
    cwd,
    env,
  );
  if ("failure" in refs) return { reason: refs.failure };
  const existing = new Set(("stdout" in refs ? refs.stdout : "").split("\n").filter(Boolean));
  const localBranches = [...existing]
    .filter((ref) => ref.startsWith(LOCAL_BRANCHES))
    .map(branchName);
  /** @type {string[]} */
  const notes = [];

  if (!("stdout" in originHead)) {
    notes.push("refs/remotes/origin/HEAD does not exist or is not a symbolic ref");
  } else if (!originHead.stdout.startsWith(ORIGIN_BRANCHES)) {
    notes.push(
      `refs/remotes/origin/HEAD points to ${originHead.stdout}, which is not a branch of origin`,
    );
  } else if (!existing.has(originHead.stdout)) {
    notes.push(`refs/remotes/origin/HEAD points to ${originHead.stdout}, which does not exist`);
  } else {
    const value = originHead.stdout.slice(ORIGIN_BRANCHES.length);
    return {
      value,
      source: "remote-default",
      detail: `refs/remotes/origin/HEAD points to origin/${value}`,
    };
  }

  const gitDefault = await git(["var", "GIT_DEFAULT_BRANCH"], cwd, env);
  if ("failure" in gitDefault) return { reason: gitDefault.failure };
  if (!("stdout" in gitDefault) || !gitDefault.stdout) {
    notes.push("git var GIT_DEFAULT_BRANCH has no value");
  } else if (localBranches.includes(gitDefault.stdout)) {
    return {
      value: gitDefault.stdout,
      source: "git-default-branch",
      detail: `git var GIT_DEFAULT_BRANCH names ${gitDefault.stdout}, and the repository has a local branch ${gitDefault.stdout}`,
    };
  } else if (localBranches.length === 0) {
    // With no local branch, HEAD can only name a branch that has no commits yet.
    const head = await git(["symbolic-ref", "--quiet", "HEAD"], cwd, env);
    if ("failure" in head) return { reason: head.failure };
    const current = "stdout" in head ? branchName(head.stdout) : undefined;
    if (current === gitDefault.stdout) {
      return {
        value: current,
        source: "git-default-branch",
        detail: `git var GIT_DEFAULT_BRANCH names ${current}, and the repository has no commits yet and is on ${current}`,
      };
    }
    notes.push(
      `git var GIT_DEFAULT_BRANCH names ${gitDefault.stdout}, and the repository has no commits yet and ${current === undefined ? "HEAD is detached" : `is on ${current}`}`,
    );
  } else {
    notes.push(
      `git var GIT_DEFAULT_BRANCH names ${gitDefault.stdout}, and the repository has no local branch ${gitDefault.stdout}`,
    );
  }

  const [onlyBranch, ...otherBranches] = localBranches;
  if (onlyBranch !== undefined && otherBranches.length === 0) {
    return {
      value: onlyBranch,
      source: "only-local-branch",
      detail: `${onlyBranch} is the repository's only local branch`,
    };
  }
  notes.push(
    localBranches.length === 0
      ? "the repository has no local branches"
      : `the repository has ${localBranches.length} local branches (${localBranches.join(", ")}), not exactly one`,
  );
  return { reason: `no source names the repository's default branch: ${notes.join("; ")}` };
}
