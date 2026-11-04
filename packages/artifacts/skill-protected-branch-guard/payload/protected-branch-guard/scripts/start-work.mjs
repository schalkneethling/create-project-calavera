#!/usr/bin/env node
import { resolve } from "node:path";
import { SCRIPTS, assertWritableBranch, branchNameProblem, branchState, git } from "./lib.mjs";

const USAGE = `Usage: node ${SCRIPTS}/start-work.mjs <slug> --base <branch> [--worktree <path>]`;

/** Reads `<slug>` followed by `--base <branch>` and an optional `--worktree <path>`, in any order. */
function parseArguments(args) {
  const [slug, ...rest] = args;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? "")) {
    throw new Error(`The slug must be lowercase words joined by hyphens. ${USAGE}`);
  }
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if ((flag !== "--base" && flag !== "--worktree") || !value || options.has(flag)) {
      throw new Error(USAGE);
    }
    options.set(flag, value);
  }
  const base = options.get("--base");
  if (base === undefined) {
    throw new Error(`--base <branch> is required. ${USAGE}`);
  }
  const problem = branchNameProblem(base, process.cwd());
  if (problem) {
    throw new Error(`The base branch is wrong: ${problem}.`);
  }
  return { branch: slug, base, worktree: options.get("--worktree") };
}

try {
  const { branch, base, worktree } = parseArguments(process.argv.slice(2));
  const { root } = branchState(process.cwd());
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).text) {
    throw new Error(
      "Working tree is dirty. Preserve existing work; do not stash, reset, or commit it automatically.",
    );
  }
  git(root, ["check-ref-format", `refs/heads/${branch}`]);
  const baseCommit = git(root, ["rev-parse", "--verify", `refs/heads/${base}^{commit}`]).text;
  const remote = git(
    root,
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`],
    { allowed: [0, 1] },
  );
  if (remote.status === 0 && remote.text !== baseCommit) {
    throw new Error(
      `Local ${base} and cached origin/${base} differ. Review and synchronize ${base} separately before starting work.`,
    );
  }
  let target = root;
  if (worktree !== undefined) {
    target = resolve(process.cwd(), worktree);
    git(root, ["worktree", "add", "--no-track", "-b", branch, target, baseCommit]);
  } else {
    git(root, ["switch", "--no-track", "-c", branch, baseCommit]);
  }
  if (assertWritableBranch(target, base).ref !== `refs/heads/${branch}`) {
    throw new Error("Created branch does not match the requested branch; stop and inspect.");
  }
  process.stdout.write(
    `Ready: ${branch}\nWorking directory: ${target}\nBase: local ${base} (${baseCommit})\nNo fetch, pull, commit, or push was performed.\n`,
  );
} catch (error) {
  process.stderr.write(`Start work refused: ${error.message}\n`);
  process.exitCode = 1;
}
