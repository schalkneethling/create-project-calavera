import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkInputValue } from "../src/ai/artifact-inputs.js";

// Ported from schalkneethling/determinant@9382bbc protected-branch-guard/guard.test.mjs. The
// installer tests are not ported, because Calavera's apply replaces install.mjs (ADR-0015,
// Decision 12).
const payload = fileURLToPath(
  new URL(
    "../../artifacts/skill-protected-branch-guard/payload/protected-branch-guard/",
    import.meta.url,
  ),
);
const scripts = ".agents/skills/protected-branch-guard/scripts";
const claudeFileTools = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * A repository with the payload installed where apply puts it, and the hook lines apply writes into
 * .vite-hooks, run by Git directly instead of through the Vite+ dispatcher.
 */
function fixture(t, { protectedBranch = "main" } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "protected-branch-guard-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "repo with spaces");
  const remote = join(temp, "remote.git");
  mkdirSync(root);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(temp, "no-global-config"),
    GIT_TERMINAL_PROMPT: "0",
  });
  function run(command, args, { cwd = root, input, status = 0, extraEnv = {} } = {}) {
    const result = spawnSync(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      input,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    if (status !== null) {
      assert.equal(
        result.status,
        status,
        `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result;
  }
  const git = (args, options) => run("git", args, options);
  const script = (name, args = [], options = {}) =>
    run(process.execPath, [join(root, scripts, name), ...args], options);
  git(["init", `--initial-branch=${protectedBranch}`]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Branch Guard Test"]);
  git(["config", "commit.gpgSign", "false"]);
  cpSync(payload, join(root, ".agents/skills/protected-branch-guard"), { recursive: true });
  writeFileSync(join(root, "example.txt"), "before\n");
  mkdirSync(join(root, ".vite-hooks"));
  for (const [hook, mode] of [
    ["pre-commit", "commit"],
    ["prepare-commit-msg", "commit"],
    ["pre-push", "pre-push"],
  ]) {
    const path = join(root, ".vite-hooks", hook);
    writeFileSync(path, `#!/bin/sh\nnode ${scripts}/guard.mjs ${mode} ${protectedBranch}\n`);
    chmodSync(path, 0o755);
  }
  git(["add", "."]);
  git(["commit", "-m", "fixture base"]);
  git(["init", "--bare", `--initial-branch=${protectedBranch}`, remote]);
  git(["remote", "add", "origin", remote]);
  git(["push", "origin", protectedBranch]);
  git(["switch", "-c", "trial"]);
  git(["config", "core.hooksPath", ".vite-hooks"]);
  // The feature branch starts one commit ahead, so a push from it has something to send.
  git(["commit", "--allow-empty", "-m", "start trial"]);
  // Commits that set up history on the protected branch skip the hooks.
  const unguarded = (args, options) => git(["-c", "core.hooksPath=/dev/null", ...args], options);
  const patch = (path = "example.txt") =>
    `*** Begin Patch\n*** Update File: ${path}\n@@\n-before\n+after\n*** End Patch`;
  const codexEvent = (command = patch()) => ({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    cwd: root,
    tool_input: { command },
  });
  const codex = (event, status = 0) =>
    script("guard.mjs", ["codex-pre-tool-use", protectedBranch], {
      input: JSON.stringify(event),
      status,
    });
  const claudeEvent = (tool, path, cwd = root) => ({
    hook_event_name: "PreToolUse",
    cwd,
    tool_name: tool,
    tool_input:
      tool === "NotebookEdit"
        ? { notebook_path: path, new_source: "x" }
        : { file_path: path, content: "after\n" },
  });
  const claude = (event, status = 0) =>
    script("guard.mjs", ["claude-pre-tool-use", protectedBranch], {
      input: JSON.stringify(event),
      status,
    });
  return {
    temp,
    root,
    remote,
    protectedBranch,
    run,
    git,
    unguarded,
    script,
    patch,
    codexEvent,
    codex,
    claudeEvent,
    claude,
  };
}

/** @param {{ stdout: string, stderr: string }} result */
function assertDenied(result) {
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /^Protected branch guard: /);
  assert.match(result.stderr, /^Protected branch guard: /);
  return output.permissionDecisionReason;
}

test("real Git commits are blocked on the protected branch, including --no-verify and an unborn branch", (t) => {
  const f = fixture(t);
  f.git(["switch", "main"]);
  const before = f.git(["rev-parse", "HEAD"]).stdout;
  for (const options of [[], ["--no-verify"]]) {
    const result = f.git(["commit", "--allow-empty", "-m", "must not exist", ...options], {
      status: 1,
    });
    assert.match(result.stderr, /main is read-only/);
    assert.equal(f.git(["rev-parse", "HEAD"]).stdout, before);
  }
  const unborn = join(f.temp, "unborn");
  mkdirSync(unborn);
  f.git(["init", "--initial-branch=main"], { cwd: unborn });
  f.script("guard.mjs", ["commit", "main"], { cwd: unborn, status: 1 });
});

test("the guard protects the branch it is given, not the literal main", (t) => {
  const f = fixture(t, { protectedBranch: "master" });
  f.git(["switch", "master"]);
  const result = f.git(["commit", "--allow-empty", "-m", "must not exist"], { status: 1 });
  assert.match(result.stderr, /master is read-only/);
  f.git(["switch", "-c", "main"]);
  f.git(["commit", "--allow-empty", "-m", "main is an ordinary branch here"]);
  f.git(["push", "origin", "HEAD:refs/heads/main"]);
  const push = f.git(["push", "origin", "HEAD:master"], { status: 1 });
  assert.match(push.stderr, /Push to master refused/);
});

test("pre-push blocks the protected destination: fast-forward, force, force-with-lease, deletion and multi-ref", (t) => {
  const f = fixture(t);
  const before = f.git(["--git-dir", f.remote, "rev-parse", "refs/heads/main"]).stdout;
  for (const args of [
    ["HEAD:main"],
    ["--force", "HEAD:main"],
    ["--force-with-lease", "HEAD:main"],
    ["+HEAD:refs/heads/main"],
    ["--delete", "main"],
    ["HEAD:refs/heads/allowed", "HEAD:main"],
  ]) {
    const result = f.git(["push", "origin", ...args], { status: 1 });
    assert.match(result.stderr, /Push to main refused/);
    assert.equal(f.git(["--git-dir", f.remote, "rev-parse", "refs/heads/main"]).stdout, before);
  }
  f.git(["--git-dir", f.remote, "show-ref", "--verify", "refs/heads/allowed"], { status: 128 });
  f.git(["push", "origin", "HEAD:refs/heads/trial"]);
  f.git(["tag", "main"]);
  f.git(["push", "origin", "refs/tags/main:refs/tags/main"]);
  f.git(["push", "origin", "--delete", "trial"]);
});

test("documents the real pre-push --no-verify bypass on a disposable remote", (t) => {
  const f = fixture(t);
  f.git(["push", "--no-verify", "origin", "HEAD:main"]);
  assert.equal(
    f.git(["--git-dir", f.remote, "rev-parse", "main"]).stdout,
    f.git(["rev-parse", "HEAD"]).stdout,
  );
});

test("pre-push handles SHA-256 records and fails closed on malformed input", (t) => {
  const f = fixture(t);
  const record = `refs/heads/topic ${"a".repeat(64)} refs/heads/main ${"0".repeat(64)}\n`;
  f.script("guard.mjs", ["pre-push", "main"], { input: record, status: 1 });
  f.script("guard.mjs", ["pre-push", "main"], { input: "broken record\n", status: 1 });
  f.script("guard.mjs", ["pre-push", "main"], { input: "", status: 0 });
});

test("a missing or invalid branch argument is an error that names the line to fix and its correct form", (t) => {
  const f = fixture(t);
  const cases = [
    ["commit", ".vite-hooks/pre-commit"],
    ["check", "the command you ran"],
    ["pre-push", ".vite-hooks/pre-push"],
  ];
  for (const [mode, location] of cases) {
    for (const args of [[mode], [mode, ""], [mode, "main", "extra"]]) {
      const result = f.script("guard.mjs", args, { status: 1, input: "" });
      assert.match(result.stderr, new RegExp(`Fix ${location.replaceAll(".", "\\.")}`), args);
      assert.match(
        result.stderr,
        new RegExp(`node ${scripts.replaceAll(".", "\\.")}/guard\\.mjs ${mode} <protected-branch>`),
      );
    }
  }
  for (const value of ["a;b", "{{protectedBranch}}", "-main", "main..dev", "@{-1}", "main.lock"]) {
    const result = f.script("guard.mjs", ["commit", value], { status: 1 });
    assert.match(result.stderr, new RegExp(`"${value.replace(/[.{}]/g, "\\$&")}"`), value);
    assert.match(result.stderr, /Fix \.vite-hooks\/pre-commit/, value);
  }

  const session = f.script("guard.mjs", ["session-start"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: f.root }),
  });
  assert.match(JSON.parse(session.stdout).systemMessage, /Fix \.claude\/settings\.json/);
  const claude = assertDenied(
    f.script("guard.mjs", ["claude-pre-tool-use"], {
      input: JSON.stringify(f.claudeEvent("Write", join(f.root, "example.txt"))),
      status: 2,
    }),
  );
  assert.match(claude, /Fix \.claude\/settings\.json/);
  const codex = assertDenied(
    f.script("guard.mjs", ["codex-pre-tool-use", "{{protectedBranch}}"], {
      input: JSON.stringify(f.codexEvent()),
      status: 2,
    }),
  );
  assert.match(codex, /Fix \.codex\/hooks\.json/);
});

test("the guard accepts exactly the branch names Calavera records as protectedBranch", async (t) => {
  const f = fixture(t);
  for (const value of [
    "main",
    "master",
    "release/2.x",
    "feature_1",
    "123-topic",
    "a;b",
    "$(id)",
    "a|b",
    "a b",
    "-main",
    "@{-1}",
    "main.lock",
    "a..b",
    "{{protectedBranch}}",
  ]) {
    const calavera = (await checkInputValue("branch-name", value, f.root)) === undefined;
    const guard = f.script("guard.mjs", ["check", value], { status: null });
    assert.equal(guard.status === 0, calavera, `${value}: ${guard.stderr}`);
  }
});

test("the old pre-tool-use mode name is refused, because each mode names the agent whose input it reads", (t) => {
  const f = fixture(t);
  const result = f.script("guard.mjs", ["pre-tool-use", "main"], {
    input: JSON.stringify(f.codexEvent()),
    status: 1,
  });
  assert.match(result.stderr, /Unknown branch guard mode "pre-tool-use"/);
  assert.match(result.stderr, /codex-pre-tool-use/);
});

test("a rebase of a feature branch passes the commit hooks, and a rebase of the protected branch is refused", (t) => {
  const f = fixture(t);
  // Every replayed commit changes a file, because a rebase may drop an empty commit.
  writeFileSync(join(f.root, "feature.txt"), "feature\n");
  f.git(["add", "feature.txt"]);
  f.git(["commit", "-m", "feature work"]);
  f.unguarded(["switch", "main"]);
  writeFileSync(join(f.root, "other.txt"), "main moved\n");
  f.unguarded(["add", "other.txt"]);
  f.unguarded(["commit", "-m", "main moves on"]);
  f.git(["switch", "trial"]);

  f.git(["rebase", "main"]);
  assert.equal(f.git(["symbolic-ref", "HEAD"]).stdout.trim(), "refs/heads/trial");
  f.git(["merge-base", "--is-ancestor", "main", "trial"]);
  f.git(["rebase", "--interactive", "--force-rebase", "main"], {
    extraEnv: { GIT_SEQUENCE_EDITOR: "true" },
  });

  f.git(["switch", "-c", "other", "main~1"]);
  writeFileSync(join(f.root, "side.txt"), "other work\n");
  f.unguarded(["add", "side.txt"]);
  f.unguarded(["commit", "-m", "other work"]);
  f.git(["switch", "main"]);
  const before = f.git(["rev-parse", "main"]).stdout;
  const result = f.git(["rebase", "other"], { status: null });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main is read-only/);
  f.git(["rebase", "--abort"]);
  assert.equal(f.git(["rev-parse", "main"]).stdout, before);
});

test("check judges the branch a stopped rebase is replaying, and still refuses any other detached HEAD", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "example.txt"), "feature\n");
  f.git(["commit", "-am", "feature edit"]);
  f.unguarded(["switch", "main"]);
  writeFileSync(join(f.root, "example.txt"), "main\n");
  f.unguarded(["commit", "-am", "main edit"]);
  f.git(["switch", "trial"]);

  f.git(["rebase", "main"], { status: 1 });
  f.git(["symbolic-ref", "--quiet", "HEAD"], { status: 1 });
  f.script("guard.mjs", ["check", "main"]);
  writeFileSync(join(f.root, "example.txt"), "resolved\n");
  f.git(["add", "example.txt"]);
  f.git(["rebase", "--continue"], { extraEnv: { GIT_EDITOR: "true" } });
  assert.equal(f.git(["symbolic-ref", "HEAD"]).stdout.trim(), "refs/heads/trial");

  f.git(["switch", "--detach"]);
  const result = f.script("guard.mjs", ["check", "main"], { status: 1 });
  assert.match(result.stderr, /detached HEAD is read-only/);
  f.git(["commit", "--allow-empty", "-m", "detached"], { status: 1 });
});

test("the Claude Code mode allows file tools on a feature branch and denies them on the protected branch", (t) => {
  const f = fixture(t);
  const file = join(f.root, "example.txt");
  for (const tool of claudeFileTools) {
    const allowed = f.claude(f.claudeEvent(tool, file));
    assert.equal(allowed.stdout, "", tool);
  }
  f.git(["switch", "main"]);
  for (const tool of claudeFileTools) {
    assert.match(assertDenied(f.claude(f.claudeEvent(tool, file), 2)), /main is read-only/, tool);
  }
  f.git(["switch", "--detach", "trial"]);
  assert.match(
    assertDenied(f.claude(f.claudeEvent("Write", file), 2)),
    /detached HEAD is read-only/,
  );
});

test("the Claude Code mode judges the repository that holds each target, not the session's", (t) => {
  const f = fixture(t);
  // From a session on the protected branch, a feature worktree is writable.
  const featureWorktree = join(f.temp, "feature checkout");
  f.git(["worktree", "add", "-b", "second", featureWorktree, "main"]);
  f.git(["switch", "main"]);
  f.claude(f.claudeEvent("Edit", join(featureWorktree, "example.txt")));
  f.claude(f.claudeEvent("Edit", join(f.root, "example.txt")), 2);
  f.git(["switch", "trial"]);

  const mainWorktree = join(f.temp, "main checkout");
  f.git(["worktree", "add", mainWorktree, "main"]);
  f.claude(f.claudeEvent("Edit", join(mainWorktree, "example.txt")), 2);
  f.claude(f.claudeEvent("Write", join(mainWorktree, "new", "dir", "file.txt")), 2);
  symlinkSync(mainWorktree, join(f.root, "linked-main"), "dir");
  f.claude(f.claudeEvent("Edit", join(f.root, "linked-main", "example.txt")), 2);
  symlinkSync(join(mainWorktree, "new.txt"), join(f.root, "dangling.txt"));
  f.claude(f.claudeEvent("Write", join(f.root, "dangling.txt")), 2);
  f.claude(f.claudeEvent("Write", join(f.root, "new", "dir", "file.txt")));
});

test("the Claude Code mode allows a path outside every Git working tree", (t) => {
  const f = fixture(t);
  f.git(["switch", "main"]);
  const scratch = join(f.temp, "scratch");
  mkdirSync(scratch);
  f.claude(f.claudeEvent("Write", join(scratch, "notes.md")));
  f.claude(f.claudeEvent("NotebookEdit", join(scratch, "deep", "analysis.ipynb")));
});

test("malformed, unsupported and oversized Claude Code input cannot authorize an edit", (t) => {
  const f = fixture(t);
  const file = join(f.root, "example.txt");
  for (const event of [
    null,
    {},
    { ...f.claudeEvent("Write", file), hook_event_name: "PostToolUse" },
    f.claudeEvent("Bash", file),
    { ...f.claudeEvent("Write", file), tool_input: {} },
    { ...f.claudeEvent("Write", file), tool_input: { file_path: "" } },
    { ...f.claudeEvent("NotebookEdit", file), tool_input: { file_path: file } },
    f.claudeEvent("Write", "relative.txt", "relative"),
    f.claudeEvent("Write", join(f.root, ".git", "config")),
    f.claudeEvent("Write", `${file}\0`),
  ]) {
    f.claude(event, 2);
  }
  f.script("guard.mjs", ["claude-pre-tool-use", "main"], { input: "{", status: 2 });
  f.script("guard.mjs", ["claude-pre-tool-use", "main"], {
    input: " ".repeat(2 * 1024 * 1024 + 1),
    status: 2,
  });
  // A relative path is resolved against the session's absolute cwd.
  f.claude(f.claudeEvent("Write", "relative.txt"));
});

test("the Codex mode allows feature work, rejects the protected branch and detached HEAD, rechecks every call", (t) => {
  const f = fixture(t);
  f.codex(f.codexEvent());
  f.git(["switch", "main"]);
  assertDenied(f.codex(f.codexEvent(), 2));
  f.git(["switch", "trial"]);
  f.codex(f.codexEvent());
  f.git(["switch", "--detach"]);
  f.codex(f.codexEvent(), 2);
});

test("the Codex mode resolves absolute, sibling, symlink, add, delete and move targets", (t) => {
  const f = fixture(t);
  const mainWorktree = join(f.temp, "main checkout");
  f.git(["worktree", "add", mainWorktree, "main"]);
  f.codex(f.codexEvent(f.patch(join(mainWorktree, "example.txt"))), 2);
  f.codex(f.codexEvent(f.patch("../main checkout/example.txt")), 2);
  symlinkSync(mainWorktree, join(f.root, "linked-main"), "dir");
  f.codex(f.codexEvent(f.patch("linked-main/example.txt")), 2);
  for (const marker of ["Add File", "Delete File"]) {
    f.codex(
      f.codexEvent(
        `*** Begin Patch\n*** ${marker}: ${mainWorktree}/new/dir/file.txt\n${marker === "Add File" ? "+new\n" : ""}*** End Patch`,
      ),
      2,
    );
  }
  f.codex(
    f.codexEvent(
      `*** Begin Patch\n*** Update File: example.txt\n*** Move to: ${mainWorktree}/moved.txt\n@@\n-before\n+after\n*** End Patch`,
    ),
    2,
  );
  f.codex(f.codexEvent("*** Begin Patch\n*** Add File: new/dir/file.txt\n+new\n*** End Patch"));
  f.codex(f.codexEvent("*** Begin Patch\n*** Delete File: example.txt\n*** End Patch"));
});

test("malformed, unsupported and oversized Codex input cannot authorize a patch", (t) => {
  const f = fixture(t);
  for (const event of [
    null,
    {},
    { ...f.codexEvent(), cwd: "relative" },
    { ...f.codexEvent(), tool_name: "Bash" },
    f.codexEvent("invalid"),
    f.codexEvent(
      "*** Begin Patch\n*** Environment ID: remote\n*** Add File: file\n+x\n*** End Patch",
    ),
    f.codexEvent(f.patch(".git/config")),
  ]) {
    f.codex(event, 2);
  }
  f.script("guard.mjs", ["codex-pre-tool-use", "main"], { input: "{", status: 2 });
  f.script("guard.mjs", ["codex-pre-tool-use", "main"], {
    input: " ".repeat(2 * 1024 * 1024 + 1),
    status: 2,
  });
});

test("parser-compatible indented headers and trailing whitespace cannot hide protected targets", (t) => {
  const f = fixture(t);
  const target = join(f.temp, "main checkout");
  f.git(["worktree", "add", target, "main"]);
  f.codex(
    f.codexEvent(
      `*** Begin Patch\n*** Add File: okay.txt\n+okay\n  *** Add File: ${target}/new.txt  \n+blocked\n*** End Patch`,
    ),
    2,
  );
  f.codex(
    f.codexEvent(
      "*** Begin Patch\n*** Add File: okay.txt\n+okay\n  *** Environment ID: remote\n*** End Patch",
    ),
    2,
  );
});

test("dangling symlinks cannot hide a new target in a protected worktree", (t) => {
  const f = fixture(t);
  const target = join(f.temp, "main checkout");
  f.git(["worktree", "add", target, "main"]);
  symlinkSync(join(target, "new.txt"), join(f.root, "dangling.txt"));
  f.codex(f.codexEvent("*** Begin Patch\n*** Add File: dangling.txt\n+blocked\n*** End Patch"), 2);
});

test("the session notice is advisory, names start-work with the base branch, and stays quiet on feature branches", (t) => {
  const f = fixture(t, { protectedBranch: "trunk" });
  const input = JSON.stringify({ hook_event_name: "SessionStart", cwd: f.root, source: "startup" });
  const notice = () =>
    JSON.parse(f.script("guard.mjs", ["session-start", "trunk"], { input }).stdout);
  assert.deepEqual(notice(), {});
  f.git(["switch", "trunk"]);
  const message = notice().hookSpecificOutput.additionalContext;
  assert.match(message, /trunk is read-only/);
  assert.ok(
    message.includes(`node ${scripts}/start-work.mjs <slug> --base trunk`),
    `The notice must name the start-work command: ${message}`,
  );
  assert.doesNotMatch(message, /\$start-work/);
  assert.equal(notice().hookSpecificOutput.hookEventName, "SessionStart");
  writeFileSync(join(f.root, "untracked.txt"), "preserve me");
  assert.match(notice().systemMessage, /existing changes/);
  assert.match(
    f.script("guard.mjs", ["session-start", "trunk"], { input: "bad json" }).stdout,
    /systemMessage/,
  );
});

test("start-work branches from the base, names the branch after the slug alone, and never tracks the base", (t) => {
  const f = fixture(t, { protectedBranch: "trunk" });
  const base = f.git(["rev-parse", "trunk"]).stdout;
  const result = f.script("start-work.mjs", ["745-next-task", "--base", "trunk"]);
  assert.match(result.stdout, /Ready: 745-next-task/);
  assert.match(result.stdout, /Base: local trunk/);
  assert.equal(f.git(["symbolic-ref", "HEAD"]).stdout.trim(), "refs/heads/745-next-task");
  assert.equal(f.git(["rev-parse", "HEAD"]).stdout, base);
  f.git(["config", "--get", "branch.745-next-task.remote"], { status: 1 });
  f.script("start-work.mjs", ["745-next-task", "--base", "trunk"], { status: 1 });
  assert.equal(f.git(["rev-parse", "HEAD"]).stdout, base);
});

test("start-work refuses a missing base, dirty work, invalid names and a divergent cached base", (t) => {
  const f = fixture(t);
  for (const args of [
    [],
    ["okay"],
    ["okay", "--base"],
    ["okay", "--base", "a;b"],
    ["okay", "--base", "missing"],
    ["okay", "--base", "main", "--base", "main"],
    ["main;echo", "--base", "main"],
    ["Uppercase", "--base", "main"],
    ["okay", "--base", "main", "--unknown"],
    ["okay", "--base", "main", "--worktree"],
  ]) {
    const result = f.script("start-work.mjs", args, { status: 1 });
    assert.match(result.stderr, /^Start work refused: /, args.join(" "));
  }
  const usage = f.script("start-work.mjs", ["okay"], { status: 1 }).stderr;
  assert.ok(usage.includes(`node ${scripts}/start-work.mjs <slug> --base <branch>`), usage);
  writeFileSync(join(f.root, "untracked.txt"), "preserve me");
  f.script("start-work.mjs", ["dirty", "--base", "main"], { status: 1 });
  assert.equal(readFileSync(join(f.root, "untracked.txt"), "utf8"), "preserve me");
  f.git(["add", "untracked.txt"]);
  f.git(["commit", "-m", "save fixture"]);
  f.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const stale = f.script("start-work.mjs", ["stale", "--base", "main"], { status: 1 });
  assert.match(stale.stderr, /Local main and cached origin\/main differ/);
  f.git(["show-ref", "--verify", "refs/heads/stale"], { status: 128 });
});

test("a new linked worktree keeps Git protection and leaves the original checkout alone", (t) => {
  const f = fixture(t);
  const target = join(f.temp, "new worktree");
  f.script("start-work.mjs", ["parallel", "--worktree", target, "--base", "main"]);
  assert.equal(f.git(["symbolic-ref", "HEAD"]).stdout.trim(), "refs/heads/trial");
  f.git(["commit", "--allow-empty", "-m", "linked feature"], { cwd: target });
  f.git(["switch", "main"], { cwd: target });
  f.git(["commit", "--allow-empty", "-m", "blocked"], { cwd: target, status: 1 });
});

test("the Claude Code settings fragment runs the guard for exactly the file tools, from any directory", (t) => {
  const f = fixture(t);
  const fragment = JSON.parse(
    readFileSync(join(payload, "hooks", "claude-code.settings.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(fragment.hooks).sort(), ["PreToolUse", "SessionStart"]);
  const [group] = fragment.hooks.PreToolUse;
  assert.deepEqual(group.matcher.split("|").sort(), [...claudeFileTools].sort());
  const command = (handler) =>
    handler.hooks[0].command.replaceAll("{{protectedBranch}}", f.protectedBranch);
  assert.match(group.hooks[0].command, /guard\.mjs" claude-pre-tool-use \{\{protectedBranch\}\}$/);
  const cwd = join(f.root, ".agents");
  const extraEnv = { CLAUDE_PROJECT_DIR: f.root };
  const event = JSON.stringify(f.claudeEvent("Edit", join(f.root, "example.txt")));
  f.run("/bin/sh", ["-c", command(group)], { cwd, input: event, extraEnv });
  f.git(["switch", "main"]);
  assertDenied(
    f.run("/bin/sh", ["-c", command(group)], { cwd, input: event, extraEnv, status: 2 }),
  );

  const [session] = fragment.hooks.SessionStart;
  assert.match(session.hooks[0].command, /guard\.mjs" session-start \{\{protectedBranch\}\}$/);
  const notice = f.run("/bin/sh", ["-c", command(session)], {
    cwd,
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: f.root, source: "startup" }),
    extraEnv,
  });
  assert.match(JSON.parse(notice.stdout).systemMessage, /main is read-only/);
});

test("the Codex hooks fragment runs from a subdirectory once the person writes the branch name", (t) => {
  const f = fixture(t);
  const config = JSON.parse(readFileSync(join(payload, "hooks", "hooks.codex.json"), "utf8"));
  const group = config.hooks.PreToolUse[0];
  assert.equal(new RegExp(group.matcher).test("apply_patch"), true);
  assert.equal(new RegExp(group.matcher).test("Bash"), false);
  const cwd = join(f.root, ".agents");
  const input = JSON.stringify(f.codexEvent());
  const unedited = f.run("/bin/sh", ["-c", group.hooks[0].command], { cwd, input, status: 2 });
  assert.match(assertDenied(unedited), /"\{\{protectedBranch\}\}".*Fix \.codex\/hooks\.json/);
  const command = group.hooks[0].command.replaceAll("{{protectedBranch}}", "main");
  f.run("/bin/sh", ["-c", command], { cwd, input });
  f.git(["switch", "main"]);
  assertDenied(f.run("/bin/sh", ["-c", command], { cwd, input, status: 2 }));
  assert.match(
    config.hooks.SessionStart[0].hooks[0].command,
    /guard\.mjs" session-start \{\{protectedBranch\}\}$/,
  );
});

test("the payload ships no Determinant installer, Git hook wrappers or test file", () => {
  for (const path of ["install.mjs", "git-hooks", "guard.test.mjs", "scripts/guard.test.mjs"]) {
    assert.throws(() => readFileSync(join(payload, path)), /ENOENT/, path);
  }
  assert.match(
    readFileSync(join(payload, "SOURCE.md"), "utf8"),
    /schalkneethling\/determinant@9382bbc/,
  );
});
