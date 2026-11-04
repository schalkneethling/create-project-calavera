import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MAX_BYTES = 2 * 1024 * 1024;

export const SCRIPTS = ".agents/skills/protected-branch-guard/scripts";

// Calavera holds the protectedBranch input to the same rule (packages/cli/src/ai/artifact-inputs.js),
// because the name is written into hook commands that a shell runs. Git alone also accepts `;`,
// `$`, or `|`.
const SHELL_SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export function git(cwd, args, { allowed = [0], input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: MAX_BYTES,
  });
  if (result.error || !allowed.includes(result.status)) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return {
    status: result.status,
    text: result.stdout.replace(/\r?\n$/, ""),
    stderr: result.stderr,
  };
}

/**
 * Returns why `name` is not a branch name the guard accepts, or undefined when it is one.
 */
export function branchNameProblem(name, cwd) {
  if (!name) {
    return "it is missing";
  }
  if (!SHELL_SAFE_BRANCH_NAME.test(name) || name.startsWith("-")) {
    return `"${name}" is not a branch name the guard accepts. Use only letters, digits, ".", "_", "-", and "/", and do not start with "-"`;
  }
  const result = git(cwd, ["check-ref-format", "--branch", name], { allowed: [0, 1, 128] });
  if (result.status !== 0) {
    return `"${name}" is not a valid branch name: git check-ref-format --branch refused it`;
  }
  if (result.text !== name) {
    return `"${name}" is not a plain branch name: git check-ref-format --branch reads it as "${result.text}"`;
  }
  return undefined;
}

export function branchState(cwd) {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).text !== "true") {
    throw new Error("A non-bare Git working tree is required.");
  }
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).text;
  const ref = git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowed: [0, 1] });
  return { root, ref: ref.status === 0 ? ref.text : null };
}

/**
 * The branch a merge-backend rebase is replaying commits onto, or null. A rebase detaches HEAD
 * while it replays, and records the branch it will move in rebase-merge/head-name.
 */
function rebasingBranch(cwd) {
  const path = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "rebase-merge/head-name"]).text);
  try {
    const name = readFileSync(path, "utf8").trim();
    return name.startsWith("refs/heads/") ? name : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Refuses when `cwd` is on the protected branch or on a detached HEAD. With `duringRebase`, a
 * detached HEAD that a rebase made is judged by the branch the rebase replays onto.
 */
export function assertWritableBranch(cwd, protectedBranch, { duringRebase = false } = {}) {
  const state = branchState(cwd);
  const protectedRef = `refs/heads/${protectedBranch}`;
  const ref = state.ref ?? (duringRebase ? rebasingBranch(cwd) : null);
  if (ref === null || ref === protectedRef) {
    throw new Error(
      `${state.root}: ${ref === null ? "detached HEAD" : protectedBranch} is read-only. Create or switch to a named feature branch before editing or committing.`,
    );
  }
  return state;
}

export async function readStdin() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      throw new Error(`Hook input exceeds ${MAX_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
