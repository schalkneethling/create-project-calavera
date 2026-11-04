#!/usr/bin/env node
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  SCRIPTS,
  assertWritableBranch,
  branchNameProblem,
  branchState,
  git,
  readStdin,
} from "./lib.mjs";

// Where each mode's command line lives, so an error can name the line to fix.
const MODES = {
  commit: ".vite-hooks/pre-commit and .vite-hooks/prepare-commit-msg",
  check: "the command you ran",
  "pre-push": ".vite-hooks/pre-push",
  "session-start": ".claude/settings.json or .codex/hooks.json",
  "claude-pre-tool-use": ".claude/settings.json",
  "codex-pre-tool-use": ".codex/hooks.json",
};

// The Claude Code tools that edit files, and the tool_input member that holds each one's path,
// read from the Claude Code 2.1.310 build: Write, Edit, and MultiEdit use file_path, and
// NotebookEdit uses notebook_path. Both are documented as absolute paths.
const CLAUDE_FILE_TOOLS = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

// Markers/whitespace verified against Codex parser.rs and streaming_parser.rs.
// This extracts touched paths, not a replacement for Codex's full patch parser.
function patchPaths(patch) {
  if (typeof patch !== "string") {
    throw new Error("Expected apply_patch tool_input.command to be a string.");
  }
  const lines = patch.trim().split(/\r?\n/);
  if (lines[0].trim() !== "*** Begin Patch" || lines.at(-1).trim() !== "*** End Patch") {
    throw new Error("Unsupported patch boundaries; use the standard apply_patch format.");
  }
  const paths = [];
  let inUpdate = false;
  for (const rawLine of lines.slice(1, -1)) {
    // Update hunks preserve leading spaces because they mark context lines.
    const line = inUpdate ? rawLine.trimEnd() : rawLine.trim();
    const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match) {
      paths.push(match[2]);
      inUpdate = match[1] === "Update File" || match[1] === "Move to";
    } else if (line.startsWith("*** ") && line !== "*** End of File") {
      throw new Error("Unrecognized patch marker; cannot safely determine target paths.");
    }
  }
  if (paths.length === 0) {
    throw new Error("Patch contains no recognized target paths.");
  }
  return paths;
}

function existingPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) {
      throw error;
    }
    try {
      lstatSync(path);
    } catch (missing) {
      if (missing.code === "ENOENT") {
        return existingPath(dirname(path));
      }
      throw missing;
    }
    // An entry exists but cannot be resolved: never treat a dangling symlink
    // as a new file in its lexical parent (it may point into the protected branch).
    throw new Error(`Cannot resolve existing path: ${path}`);
  }
}

/**
 * The directories whose branch decides whether `path` may change: the target's nearest existing
 * parent and, when it exists, the resolved target itself, so a symlink is judged where it points.
 */
function targetDirectories(cwd, path) {
  if (path.includes("\0") || path.split(/[\\/]/).includes(".git")) {
    throw new Error("Direct writes to Git metadata are not supported by this guard.");
  }
  const absolute = resolve(cwd, path);
  return [existingPath(dirname(absolute)), existingPath(absolute)].map((target) =>
    // existingPath may return a file; Git must run from its parent.
    statSync(target).isDirectory() ? target : dirname(target),
  );
}

function checkPatch(event, protectedBranch) {
  if (event?.hook_event_name !== "PreToolUse" || event.tool_name !== "apply_patch") {
    throw new Error("Unexpected hook event or tool; this adapter only supports apply_patch.");
  }
  if (typeof event.cwd !== "string" || !isAbsolute(event.cwd)) {
    throw new Error("Hook cwd must be an absolute path.");
  }
  // Check the session AND each target: absolute paths, sibling repositories,
  // nested repositories, symlinks, and both sides of a move need protection.
  assertWritableBranch(event.cwd, protectedBranch);
  const checked = new Set();
  for (const path of patchPaths(event.tool_input?.command)) {
    for (const directory of targetDirectories(event.cwd, path)) {
      if (!checked.has(directory)) {
        assertWritableBranch(directory, protectedBranch);
        checked.add(directory);
      }
    }
  }
}

/**
 * Judges the branch of the repository that holds the target path. A path outside every Git
 * working tree is allowed, because an edit there changes no branch.
 */
function checkClaudeEdit(event, protectedBranch) {
  const member = CLAUDE_FILE_TOOLS[event?.tool_name];
  if (event?.hook_event_name !== "PreToolUse" || member === undefined) {
    throw new Error(
      `Unexpected hook event or tool; this adapter only supports ${Object.keys(CLAUDE_FILE_TOOLS).join(", ")}.`,
    );
  }
  const path = event.tool_input?.[member];
  if (typeof path !== "string" || path === "") {
    throw new Error(`Expected ${event.tool_name} tool_input.${member} to be a non-empty string.`);
  }
  if (!isAbsolute(path) && (typeof event.cwd !== "string" || !isAbsolute(event.cwd))) {
    throw new Error("A relative target path needs an absolute hook cwd.");
  }
  for (const directory of new Set(targetDirectories(event.cwd ?? "/", path))) {
    const inside = git(directory, ["rev-parse", "--is-inside-work-tree"], { allowed: [0, 128] });
    if (inside.status === 128) {
      if (/not a git repository/i.test(inside.stderr)) {
        continue;
      }
      throw new Error(`git rev-parse failed: ${inside.stderr.trim()}`);
    }
    assertWritableBranch(directory, protectedBranch);
  }
}

function checkPush(input, protectedBranch) {
  for (const line of input.trim().split("\n")) {
    if (!line) {
      continue;
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[0-9a-f]+$/.test(fields[1]) || !/^[0-9a-f]+$/.test(fields[3])) {
      throw new Error("Malformed pre-push ref record; refusing the push.");
    }
    if (fields[2] === `refs/heads/${protectedBranch}`) {
      throw new Error(
        `Push to ${protectedBranch} refused (including force updates and deletion). Push a feature branch and open a pull request.`,
      );
    }
  }
}

function sessionNotice(event, protectedBranch) {
  if (
    event?.hook_event_name !== "SessionStart" ||
    typeof event.cwd !== "string" ||
    !isAbsolute(event.cwd)
  ) {
    throw new Error("Expected SessionStart with an absolute cwd.");
  }
  const state = branchState(event.cwd);
  if (state.ref !== null && state.ref !== `refs/heads/${protectedBranch}`) {
    return {};
  }
  const dirty = git(state.root, ["status", "--porcelain=v1", "--untracked-files=all"]).text !== "";
  const message = `${state.root}: ${state.ref === null ? "detached HEAD" : protectedBranch} is read-only for discovery/review.${dirty ? " WARNING: existing changes are present; preserve them and ask how to move them." : ` Before editing, run \`node ${SCRIPTS}/start-work.mjs <slug> --base ${protectedBranch}\` to create a feature branch.`}`;
  return {
    systemMessage: message,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message },
  };
}

/** Reads the mode and the protected branch, and names the line to fix when either is wrong. */
function parseArguments(args) {
  const [mode, protectedBranch, ...extra] = args;
  if (!Object.hasOwn(MODES, mode ?? "")) {
    throw new Error(
      `Unknown branch guard mode${mode === undefined ? "" : ` "${mode}"`}. Usage: node ${SCRIPTS}/guard.mjs ${Object.keys(MODES).join("|")} <protected-branch>`,
    );
  }
  const problem =
    extra.length > 0
      ? `it received ${extra.length} extra argument${extra.length === 1 ? "" : "s"}`
      : branchNameProblem(protectedBranch, process.cwd());
  if (problem) {
    throw new Error(
      `The protected branch argument is wrong: ${problem}. Fix ${MODES[mode]}: the line must read node ${SCRIPTS}/guard.mjs ${mode} <protected-branch>, for example node ${SCRIPTS}/guard.mjs ${mode} main.`,
    );
  }
  return protectedBranch;
}

const mode = process.argv[2];
try {
  const protectedBranch = parseArguments(process.argv.slice(2));
  if (mode === "commit" || mode === "check") {
    assertWritableBranch(process.cwd(), protectedBranch, { duringRebase: true });
  } else if (mode === "pre-push") {
    checkPush(await readStdin(), protectedBranch);
  } else if (mode === "codex-pre-tool-use") {
    checkPatch(JSON.parse(await readStdin()), protectedBranch);
    // Empty success preserves Codex's normal approval/sandbox decision.
  } else if (mode === "claude-pre-tool-use") {
    checkClaudeEdit(JSON.parse(await readStdin()), protectedBranch);
    // Empty success preserves Claude Code's normal permission decision.
  } else if (mode === "session-start") {
    process.stdout.write(
      `${JSON.stringify(sessionNotice(JSON.parse(await readStdin()), protectedBranch))}\n`,
    );
  }
} catch (error) {
  const reason = `Protected branch guard: ${error.message}`;
  if (mode === "session-start") {
    process.stdout.write(`${JSON.stringify({ systemMessage: reason })}\n`);
  } else if (mode === "codex-pre-tool-use" || mode === "claude-pre-tool-use") {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })}\n`,
    );
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  }
}
