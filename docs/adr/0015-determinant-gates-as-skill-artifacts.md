# ADR-0015: Determinant Gates as Calavera Artifacts in a Vite+ Project

- **Status:** Accepted (2026-10-31; proposed 2026-10-22, revised 2026-10-23, amended by the owner's rulings of 2026-10-31 in Decisions 5, 6, and 16)
- **Date:** 2026-10-22
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/743
- **Decides:** how the Determinant gates of Increment 1 reach a project that `vp create` scaffolded.
  - `protected-branch-guard` is copied into a skill artifact. Apply writes the skill directory under `.agents/skills/` and, through new manifest metadata, wires it into the project: a marked block in each of `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and owned entries in `.claude/settings.json`. The dry run lists every one of these writes before the person approves them.
  - Calavera never sets `core.hooksPath`. Vite+ keeps the dispatcher, and Calavera writes only into the project-owned scripts that the dispatcher runs.
  - The protected branch is an input of the artifact. Calavera asks for it, offers the current branch as the default, and records the answer in the recipe. The hook lines and the Claude Code entries carry it as an argument.
  - The copied scripts are linted, formatted, and tested with the rest of this repository, and the copy fixes the defects this ADR's review of the scripts found.
  - `agent-red-test-verification` is deferred from Increment 1. Tracking issue #744 records why and what would bring it back.
  - The C8 safety properties (`docs/evolution-brief.md`, Section 3) are not weakened. This ADR extends where the CLI writes, and Decision 9 states how each property holds for the new writes.

## Context

The Increment 1 exit condition, handoff H0, says the agent-first flow "installs repository controls, governance and drift checks, EditorConfig, Knip, the selected Determinant gates, and the MCP registration" on a fresh `vp create` library monorepo (`docs/cross-repo/sequencing-map.md:14`). Section 0 of the same file names the first slice: catalog `protected-branch-guard` and `agent-red-test-verification` "as artifacts from their current scripts", add `deterministic-pnpm-install` only "if the existing artifact path carries it without a schema change", and treat a gate that metadata cannot express as "a request, not a blocker" (`docs/cross-repo/sequencing-map.md:23`).

Determinant is a collection of copy-paste scenarios in https://github.com/schalkneethling/determinant, under the MIT license and the same owner as Calavera. It publishes no package. This ADR reads it at commit `9382bbc`.

- `protected-branch-guard` refuses a commit on `main` and a push to `main`. It has `guard.mjs` and `lib.mjs` (the policy, with `commit`, `pre-push`, `session-start`, `pre-tool-use`, and `check` modes), `start-work.mjs` (creates a work branch from `main`), three Git hook wrappers under `git-hooks/`, `hooks.codex.json` (Codex `SessionStart` and `PreToolUse` hooks), `start-work/SKILL.md`, `install.mjs`, and `guard.test.mjs`. The only protected ref is the literal `refs/heads/main` (`lib.mjs:26`, `guard.mjs:92`).
- `agent-red-test-verification` asks for RED evidence: proof that a test for an acceptance criterion fails before the change that should make it pass. It is a four-step lifecycle of `agent-preflight.mjs`, `agent-verify-red.mjs`, `agent-verify-changed.mjs`, and `agent-handoff.mjs`, which share `lib/agent-lifecycle.mjs`. `agent-verify-red.mjs` requires a criterion declared as a `## AC-AREA-NNN` heading in `docs/acceptance/*.md` and then requires the given test command to fail. Every step first runs the project's guardrails, the `check-*.mjs` scripts, and refuses when there are none.
- `deterministic-pnpm-install` has three example files (`package.example.json`, `pnpm-workspace.example.yaml`, `ci.example.yml`) and no script.

Two rules in `docs/evolution-brief.md` decide how far Calavera can go. The litmus test (C1) says Calavera steps aside wherever it would fight Vite+. Vite+ owns the hook dispatcher and `core.hooksPath`, but it does not own the hook scripts: its guide says that project-owned scripts such as `.vite-hooks/pre-commit` belong to the project and are committed, and that Vite+ never "creates or modifies project hook scripts". Adding a line to one of those scripts therefore uses the Vite+ mechanism instead of competing with it. C8 says that only the CLI writes into projects and that local edits are preserved. A write that apply makes after `dry_run_apply` is a CLI write, so C8 does not require the person to make these edits by hand. It does require that the writes stay visible in the dry run and never overwrite what the person wrote. The first version of this ADR left the wiring to the person. The owner's review of 2026-10-23 asked Calavera to make it, and this revision does so under both rules.

## Evidence

The evidence comes from Calavera's code at `origin/main` (`99242ec`), from the Determinant clone at `9382bbc`, from probes run on 2026-10-22 with vite-plus 1.2.0, Git 2.55.0, and Node.js 24.22.1, from a probe of the guard against `git rebase` run on 2026-10-23, and from the Claude Code hooks documentation read on 2026-10-23. The Git probes of 2026-10-22 ran in a fresh `git init` repository under the scratchpad that holds a copy of a scratch `vp create vite:monorepo` project's files and installed dependencies. The machine has no `init.defaultBranch` setting, so the repository started on `master`. Commit signing stayed on: the probe repository's local `user.signingkey` is the key this project's own repository uses, and every probe commit carries an SSH signature.

**`vp config` sets `core.hooksPath`, in CI too.** In the fresh repository, `git config --get core.hooksPath` exited 1. `CI=true node node_modules/vite-plus/bin/vp config` exited 0, and the local configuration then held `core.hookspath=.vite-hooks/_`, `vp.hooks.dir=.vite-hooks`, and `vp.hooks.prefix=.`, with the dispatcher installed under `.vite-hooks/_/`. The scaffold's `package.json` runs this on every install as `"prepare": "vp config"`, and `vp create --help` lists `--hooks` as "Set up pre-commit hooks (default in non-interactive mode)". The bundled guide (`node_modules/vite-plus/docs/guide/commit-hooks.md`) adds two facts that matter here: "If `core.hooksPath` points to another hook directory, `vp config` skips dispatcher installation", and project-owned scripts such as `.vite-hooks/pre-commit` "should be committed to the repository", while the dispatcher under `.vite-hooks/_` is ignored and recreated. Neither `vp config` nor `vp hooks` "creates or modifies project hook scripts". No file in `packages/cli/src` or `packages/artifact-core/src` mentions `hooksPath` or `.vite-hooks`.

**How the dispatcher runs a project hook.** `vp config` creates `.vite-hooks/_/` with a `.gitignore` containing `*`, one shim per Git hook (each sources `h`), and the shared script `h`. `h` exits 0 when `.vite-hooks/<hook>` does not exist, sources `~/.config/vite-plus/hooks-init.sh` (or `~/.config/husky/init.sh`) when present, exits 0 when `HUSKY`, `VP_GIT_HOOKS`, or `VITE_GIT_HOOKS` is `0`, prepends `node_modules/.bin` to `PATH`, and runs the project-owned script with `sh -e`, so the script needs no executable bit and stops at its first failing line. The scaffold's `.vite-hooks/pre-commit` holds one line, `vp staged`, and its `vite.config.ts` sets `staged: { "*": "vp check --fix" }`.

**The guard works through the dispatcher, and the first line runs first.** The Determinant `guard.mjs` and `lib.mjs` were copied to `.agents/skills/protected-branch-guard/scripts/`. `.vite-hooks/pre-commit` was rewritten to hold `node .agents/skills/protected-branch-guard/scripts/guard.mjs commit` followed by `vp staged`. The same `commit` line went into a new `.vite-hooks/prepare-commit-msg`, and `node .agents/skills/protected-branch-guard/scripts/guard.mjs pre-push` into a new `.vite-hooks/pre-push`. On a branch named `main`, with an unformatted file staged, `git commit -m "on main"` exited 1 with "Protected branch guard: … main is read-only. Create or switch to a named feature branch before editing or committing." followed by "VITE+ - pre-commit script failed (code 1)". `vp staged` printed nothing, and the staged file stayed unformatted, so the guard refused before any file was rewritten. `git push origin main` to a local bare remote exited 1 with "Push to main refused (including force updates and deletion)". The guard reads Git's ref records from standard input and skips empty input, so that refusal also shows that the dispatcher passes the records through. `git push origin master` exited 0, which shows that the unmodified guard protects only the literal `main`. The `git commit --no-verify` case was not rerun for this ADR; the Determinant README states that `prepare-commit-msg` still runs under `--no-verify`, and `guard.test.mjs:52-56` covers it.

**The guard takes exactly one argument today.** `node .agents/skills/protected-branch-guard/scripts/guard.mjs commit master` exited 1 with "Protected branch guard: Usage: node protected-branch-guard/guard.mjs commit|pre-push|session-start|pre-tool-use|check", because `guard.mjs:116` refuses any `process.argv` length other than 3.

**The guard breaks `git rebase` on a feature branch.** In a fresh repository with the unmodified guard as `prepare-commit-msg` and `pre-commit`, `git rebase main` on a feature branch named `feat` stopped at its first commit with "detached HEAD is read-only" and "error: 'prepare-commit-msg' hook failed", and exited 1. An interactive rebase with `reword` stopped the same way. A rebase detaches HEAD while it replays commits, and `assertWritableBranch` refuses every detached HEAD (`lib.mjs:26`). While the rebase ran, `$(git rev-parse --git-path rebase-merge/head-name)` held `refs/heads/feat`, the branch being rebased. With `rebase.backend=apply`, the hook did not run at all. `git cherry-pick` onto another feature branch exited 0, because HEAD stays on a branch.

**`vp staged` rewrites unformatted payload files.** The commit that added the two scripts on `master`, which the unmodified guard does not protect, ran `vp check --fix` over the five staged files and exited 0. It changed the SHA-256 of `guard.mjs` from `a8fd0844…` to `d37c57d6…` and of `lib.mjs` from `1673d4b1…` to `95db4414…`, and the committed files grew from 145 and 43 lines to 159 and 49. In Calavera, an installed skill whose hash matches neither its source nor its state record makes the next apply stop with "Refusing to overwrite existing AI artifact: <path>. It appears to have local edits" (`assertSafeAiWrite`, `packages/cli/src/ai/artifacts.js:443-473`). Running this repository's `oxfmt` 0.73.0 with `--write` and no configuration on fresh copies of the two files produced the same two hashes, and vite-plus 1.2.0 installs `oxfmt@0.73.0` in the copy's `node_modules/.pnpm`. `oxfmt --check` on the candidate payloads described below reported four files: `hooks/hooks.codex.json`, `scripts/guard.mjs`, `scripts/lib.mjs`, and `scripts/start-work.mjs`. The existing hook payload `packages/artifacts/hook-block-dangerous-commands/payload/block-dangerous-commands/hook.mjs`, which `.prettierignore` exempts, fails `oxfmt --check` too.

**Ways the guard stops running.** On `main`, `VITE_GIT_HOOKS=0`, `HUSKY=0`, and `VP_GIT_HOOKS=0` each let `git commit` exit 0 with a signed commit. `vp hooks disable` printed "unset core.hooksPath (was ".vite-hooks/_"); removed .vite-hooks/_", the next commit on `main` exited 0, and a later `vp config` printed "skip install (hooks disabled; run `vp hooks enable` to re-enable)" and left `core.hooksPath` unset, because `disable` records `vp.hooks.disabled=true` in the clone's Git configuration.

**A linked worktree has no dispatcher by default.** `git worktree add --detach` created a worktree whose `.vite-hooks/` held `pre-commit`, `pre-push`, and `prepare-commit-msg` but no `_`, because `_` is ignored. `core.hooksPath` still read `.vite-hooks/_`, which Git resolves inside that worktree. A commit there on a detached HEAD, which the guard refuses, exited 0 with no `vp staged` output, and the unformatted file it added stayed unformatted. Running `vp config` inside the linked worktree created `.vite-hooks/_` there. The guard then ran and refused the detached HEAD. On a branch in the same worktree, the guard passed and `vp staged` failed with "Cannot find package 'vite-plus'", because the worktree had no installed dependencies. The scaffold's `.gitignore` lists `.claude/worktrees/` under "AI agent worktrees", so the worktrees agents create are linked worktrees of this kind.

**What Git records about the current and default branch.** `git var GIT_DEFAULT_BRANCH` printed `master`, the name Git gives new repositories on this machine, not a property of the repository. After `git push`, `refs/remotes/origin/HEAD` did not exist. After `git fetch`, it pointed to `refs/remotes/origin/master`, taken from the bare remote's own `HEAD`. A repository without a remote, which is what `vp create --git` produces, records no default branch at all. It does record its current branch: `git symbolic-ref --short HEAD` names the branch even before the first commit, and fails only on a detached HEAD.

**The RED gate accepts any non-zero exit.** In `packages/utils` of a copy of the scratch project, `vp test run tests/definitely-missing.test.ts` printed "No test files found, exiting with code 1" and exited 1. With a guardrail that exits 0 and `docs/acceptance/probe.md` declaring `## AC-PROBE-001`, `node agent-verify-red.mjs --criterion AC-PROBE-001 -- vp test run tests/definitely-missing.test.ts` exited 0 with "RED evidence captured for AC-PROBE-001". `runExpectedFailure` (`agent-red-test-verification/lib/agent-lifecycle.mjs:20-40`) rejects only exit 0 and a signal.

**What Claude Code hooks receive and return.** The Claude Code hooks reference (https://code.claude.com/docs/en/hooks) states that committed project hooks live in `.claude/settings.json` as event, matcher group, and handler, for example `{"hooks": {"PreToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "…"}]}]}}`, where a matcher made of letters and `|` is an exact list. A `PreToolUse` hook receives `hook_event_name`, `cwd`, `tool_name`, and `tool_input` on standard input, and "For the file tools Write, Edit, and Read, tool_input.file_path is always absolute." A hook denies with `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "…"}}`, and exit code 2 also blocks, with standard error sent to Claude. A `SessionStart` hook receives `source` (`startup`, `resume`, `clear`, `compact`, or `fork`), and its `hookSpecificOutput.additionalContext` is added to the conversation. The command receives `CLAUDE_PROJECT_DIR`, the project root where the session started. The worktrees page (https://code.claude.com/docs/en/worktrees) states that in a `.claude/worktrees/<name>/` worktree, `${CLAUDE_PROJECT_DIR}` still points at the main checkout, while the hook's `cwd` is the worktree root. The pages read do not document the path fields of `MultiEdit` and `NotebookEdit`. Determinant's `pre-tool-use` mode reads only the Codex `apply_patch` input (`guard.mjs:56-58`), so it refuses every Claude Code event as "Unexpected hook event or tool".

**SkillSpector passes the candidate guard payload, which is not final.** The candidate payloads were built in the scratchpad from the Determinant files at `9382bbc` in the layouts planned by #745 (the issue that adds the `skill-protected-branch-guard` artifact) and #746 (the issue that adds the `skill-red-test-verification` artifact). They hold the script changes of the first version of this ADR, a draft `SKILL.md`, the hook fragment, and `SOURCE.md`. They are not formatted by Oxfmt and lack the branch argument. `uv run --frozen skillspector scan <payload> --no-llm`, run from this repository with SkillSpector 2.3.13 (the commit `pyproject.toml` pins), exited 0 for each, with "No security issues detected", a risk score of 0/100, and seven components each. The report typed every `.mjs` file as `other` and "Executable: No", so a clean scan says little about what the scripts do when they run. #745 must scan its final payload again.

**Calavera's artifact path.** The schema allows three kinds, `skill`, `hook`, and `agent` (`packages/cli/schemas/calavera-artifact.schema.json:22`), and forbids `targets` on a skill (`:55-60`). A skill installs to `.agents/skills/<name>/` (`packages/cli/src/ai/artifacts.js:233-236`) as a recursive copy of its whole payload directory (`:410-414`). A hook copies exactly `hook.mjs` and `settings-fragment.json` (`:37`, `:419-426`). Any skill in a recipe also plans `.coderabbit.yaml`, as a `write` when the file is missing and as an `update` when it lacks Calavera's path filters (`:65-105`, `:483`, `:557-571`). The artifact lifecycle keeps its lock, state, extracted packages, cache, and transactions under `.calavera/` (`packages/cli/src/artifact-lifecycle.js:25-30`). The MCP tools `dry_run_apply` and `apply_recipe` default `writeConfig` to true (`packages/cli/src/mcp.js:244`, `:261`). Calavera never merges a settings fragment today: the hook pointer tells the person to review `settings-fragment.json` "before wiring them into agent settings" (`artifacts.js:544`), and `docs/ai-adapter-guidance.md:27` says Calavera "does not currently write `.claude/`, `.codex/`, editor settings, global agent directories, symlinks, or machine-local configuration". Recipes select artifacts by ID, as in `{ "id": "skill-project-goal" }` (`README.md`, "Versioned artifacts"; `packages/cli/src/ai/recipe-items.js:46-53`).

**How Calavera already owns part of a project file.** The bootstrap owns a marked section of `AGENTS.md` between `<!-- calavera-agent-bootstrap:start -->` and `<!-- calavera-agent-bootstrap:end -->` (`packages/cli/src/index.js:243-245`). It appends the section when the markers are missing, keeps all text outside them, and replaces all text between them (`upsertAgentBootstrapGuidanceSection`, `index.js:3060-3080`). It does not compare the section with what it wrote last, so an edit between the markers is replaced without a stop.

**The MCP registration.** The bootstrap's next prompt tells the agent to "verify that the Calavera MCP tools are available" and, if they are not, to "stop and help me configure the MCP server before composing or applying anything" (`packages/cli/src/index.js:250-251`). The bootstrap writes `.mcp.json` only for the `claude-code` harness; the other harnesses map to `.codex/config.toml`, `.cursor/mcp.json`, and `opencode.json` (`packages/cli/src/utils/mcp-config.js:303-316`). Without `--mcp-harness`, `resolveAgentBootstrapMcpHarness` returns `skip` under `--json`, `--yes`, or a standard input that is not a TTY (`packages/cli/src/index.js:2959-2966`). The project JSON writer compares text, `currentContents === nextContents` (`mcp-config.js:66-97`), and replaces the whole `mcpServers.calavera` entry (`:118-138`).

## Review of the copied scripts

The owner asked for the scripts to be reviewed for defects before Calavera adopts them. These are the findings, read against `9382bbc`. Each finding for the guard is fixed in the copy (Decision 7). The findings for the red-test gate are recorded in #744, because that gate is deferred (Decision 11).

`protected-branch-guard`:

- **Rebase is refused.** The `commit` mode refuses every detached HEAD, and a rebase detaches HEAD, so `git rebase` fails on any feature branch (see Evidence). The guard should judge the branch named in `rebase-merge/head-name` while a rebase runs, and still refuse when that branch is the protected one.
- **The protected branch is the literal `main`** in `lib.mjs:26`, `guard.mjs:92`, `guard.mjs:103`, and `start-work.mjs:17-18`, and `guard.mjs:116` accepts no argument that could change it.
- **The `pre-tool-use` mode understands only Codex `apply_patch`** (`guard.mjs:56-58`), so it cannot serve Claude Code.
- **The session notice names a Codex skill.** "Use $start-work <slug>" (`guard.mjs:107`) is Codex syntax, and the notice is wrong for every other agent.
- **`start-work.mjs` hard-codes the `codex/` prefix** (`start-work.mjs:15`), which names one agent instead of the work.
- **The session notice can time out.** `git()` has a 5-second timeout (`lib.mjs:7`), and the notice runs `git status --untracked-files=all` (`guard.mjs:106`). In a large repository the notice then reports a Git error instead of the branch state. It blocks nothing, because `session-start` never blocks, so the copy keeps the timeout and the limit is documented in `SKILL.md`.

`agent-red-test-verification`:

- **The evidence is not stored.** `agent-verify-red.mjs` prints "RED evidence captured" and asks the agent to record it (`agent-verify-red.mjs:46-48`). No later step reads it, so nothing can check at handoff or in CI that a RED run happened.
- **Any non-zero exit counts as RED**, including "No test files found" for a misspelled path (see Evidence).
- **`--criterion` is read from anywhere in the arguments** (`agent-verify-red.mjs:31-33`), including after `--`, so a test command's own `--criterion` flag can be taken as the criterion.
- **The handoff checks only unstaged whitespace.** `git diff --check` (`agent-handoff.mjs:3`) skips staged and committed changes, and `git status --short` always exits 0.
- **Guardrails are read from beside the scripts** (`lib/agent-lifecycle.mjs:6`, `:43`), which is inside the Calavera-owned skill directory, and `agent-verify-changed.mjs:3` hard-codes `pnpm test` and `pnpm run typecheck`.

## Decision

### 1. Copy the scripts and record their source in `SOURCE.md`

Calavera copies the Determinant scripts into an artifact package and does not depend on Determinant. Determinant publishes nothing, so there is no version to pin, and the copy needs changes (Decision 7) that a pin could not carry. The payload holds a `SOURCE.md` that names `schalkneethling/determinant@9382bbc`, the folder it came from, and every changed behavior, so a later comparison with upstream starts from a known point. The artifact package is the versioned unit a project updates through `artifacts update`.

### 2. The guard is a skill artifact

The package is `@schalkneethling/calavera-skill-protected-branch-guard`, with the ID `skill-protected-branch-guard`. A skill copies its whole payload directory, so it can carry `SKILL.md` and the scripts together. A hook artifact copies only `hook.mjs` and `settings-fragment.json`, which cannot carry a set of scripts, and it would add one more unchecked `targets` claim (`packages/artifact-core/src/catalog.js:8`).

### 3. Calavera never sets `core.hooksPath`

`vp config` sets `core.hooksPath` to `.vite-hooks/_` in every clone through the `prepare` script. If Calavera set it to another directory, `vp config` would skip installing the dispatcher, and `vp staged` would stop running before every commit. That is the fight with Vite+ that the litmus test forbids. The key also lives in `.git/config`, which is not a project file Calavera tracks: no state record, hash, dry-run change, or `clean` covers it. Calavera writes no Git configuration at all. Its Git wiring goes only into the project-owned scripts under `.vite-hooks/` (Decision 5).

### 4. Wiring is manifest metadata

Following "metadata before code", the artifact manifest gains an optional `wiring` object, allowed on a skill, with two members. The exact schema is settled in #745, and these names are the proposal it starts from.

- `viteHooks`: a map from a Git hook name (`pre-commit`, `prepare-commit-msg`, `pre-push`) to the command line that apply places in `.vite-hooks/<hook>`.
- `claudeCode`: the path, inside the payload, of a Claude Code settings fragment whose entries apply merges into `.claude/settings.json`.

Both may reference declared inputs (Decision 6) with a placeholder that apply replaces before it writes, so the written lines and entries hold plain values. A command in either member runs the payload's scripts by their installed path, so apply can check that every command points into the artifact's own skill directory and refuse a manifest whose command points elsewhere.

A recipe that selects the guard without wiring is not offered. The guard without its wiring is a set of scripts that nothing runs, which is the failure the first version of this ADR left to a manual step.

### 5. How apply writes the wiring

**`.vite-hooks/<hook>`.** Apply owns one block in each script, delimited by shell comments:

```sh
# calavera:skill-protected-branch-guard:start
node .agents/skills/protected-branch-guard/scripts/guard.mjs commit main
# calavera:skill-protected-branch-guard:end
```

- When the file does not exist, which is the case for `prepare-commit-msg` and `pre-push` in the scaffold, apply creates it with the block alone.
- When the file exists without the block, apply inserts the block at the top, after a `#!` line if there is one, so the guard refuses before `vp staged` rewrites any staged file. Every other line stays as it was.
- When the block exists and its text matches what the state record says apply wrote last, apply replaces the block with the new text and touches nothing outside it.
- When the block exists and its text differs from the state record, the person edited it. Apply stops with a conflict that names the file and shows both texts, and it writes nothing. This is stricter than the `AGENTS.md` section, which is replaced without a check, because these lines run on every commit.
- When only one of the two markers is present, apply stops with a conflict, because it cannot tell where its block ends.

**`.claude/settings.json`.** Apply parses the file and stops with a conflict when it is not valid JSON. It adds the fragment's matcher groups to `hooks.SessionStart` and `hooks.PreToolUse` and keeps every other key, event, and group. The state record holds the exact groups apply wrote. On a later apply, a group that matches the record is replaced, a missing group is added again only after the dry run reports it as a change, and a group whose command still points into the skill directory but whose text differs from the record is a conflict. Calavera writes nothing to `.claude/settings.local.json`, which is personal and ignored by Git.

**Format.** Both writers produce text that already passes the project's `vp check`, as the owner's #669 ruling requires. The `.vite-hooks` scripts have no file extension, so Oxfmt does not format them, and the block is written as it will stay. `.claude/settings.json` is rewritten as a whole, so its text is formatted in memory before the dry run, by passing it through the project's own `vp fmt --stdin-filepath`, which prints the formatted text and writes nothing (`packages/cli/src/utils/project-formatter.js`). The project's Oxfmt version, its `fmt` settings in `vite.config.ts`, `.editorconfig`, and its ignore patterns then apply exactly as they do for `vp check`, and the dry run shows the bytes apply writes. Nothing is formatted after it is written. A project that Vite+ does not manage gets `JSON.stringify` output with two-space indentation, because no Oxfmt check runs there. _Amended 2026-10-31: the first text required output that passes `oxfmt --check` with no configuration, which a project with its own `fmt` settings would still fail._

**Dry run.** `dry_run_apply` and `apply --dry-run` list each of the four files with `write`, `update`, `unchanged`, or `conflict`, and show the lines or groups that will change, so the approval covers the exact text. When the current branch is the protected branch, the dry run also warns that the commit of the applied files will be refused, and tells the person to create a feature branch first.

### 6. The protected branch is an input that Calavera asks for

The manifest declares an input, `protectedBranch`, with a prompt, a default, and a check. The interactive CLI asks for it. The default is the current branch, read with `git symbolic-ref --short HEAD`, which on a fresh `vp create` project is the branch Git created, `main` or `master`, and which works before the first commit. On a detached HEAD there is no default, and the person must type a name. The answer must pass `git check-ref-format --branch`.

The answer is recorded in the recipe, on the artifact's entry, as in `{ "id": "skill-protected-branch-guard", "inputs": { "protectedBranch": "main" } }`. A later apply, a non-interactive run, and the MCP flow read it from there and do not ask again. `compose_recipe` returns the input with its default, and the bootstrap guidance tells the agent to confirm the name with the person before `dry_run_apply`. A non-interactive run without a recorded value uses the default and says so in the dry run. Without a default, on a detached HEAD, the run stops and names the missing input.

**Amended by the owner on 2026-10-31.** A value from the default is never written without approval. `dry_run_apply` and `apply --dry-run` fill it in, report it with its source, and return the recipe that records it in `result.recipe`. `apply_recipe` and any other apply that cannot ask the person refuse an input the recipe does not record, name each one with the value the dry run would use, and write nothing. The agent therefore passes the dry run's recipe to `apply_recipe`, so the branch cannot change between the approval and the apply, for example when the person creates a feature branch in between. An interactive `apply` asks and records the answer, and `init` records the value it used, saying so when it was the default. This replaces "A non-interactive run without a recorded value uses the default" above for apply.

Apply then writes the name as the last argument of every guard command it places (Decision 5). The lines are committed, so every clone and every CI job reads the same name, and a reviewer sees it. The prompt replaces detection as the source of the value: the first version rejected detection because a detected name is not one anyone chose, and a default that the person confirms is chosen.

### 7. The changes to the copied script

The copy changes these behaviors, and `SOURCE.md` lists each one:

1. The guard takes the protected branch as a required last argument in every mode, checks it with `git check-ref-format --branch`, and uses it wherever `refs/heads/main` appears today. A missing, empty, or invalid argument is an error whose message names the line to fix and shows its correct form.
2. While a rebase runs, the `commit` and `check` modes judge the branch named in `rebase-merge/head-name` instead of refusing the detached HEAD. Any other detached HEAD is still refused.
3. A new `claude-pre-tool-use` mode reads Claude Code's `PreToolUse` input. It judges the branch of the repository that holds each target path, from `tool_input.file_path` and the path fields that #745 confirms for `MultiEdit` and `NotebookEdit` against the installed Claude Code build. #745 confirmed them in Claude Code 2.1.310: `Write`, `Edit`, and `MultiEdit` carry the path in `tool_input.file_path`, and `NotebookEdit` in `tool_input.notebook_path`. It denies with the documented `permissionDecision: "deny"` output and exit code 2. A path outside every Git working tree is allowed, because the guard protects branches, and an edit to a scratch file outside the repository changes no branch. The existing `pre-tool-use` mode stays for Codex and is renamed `codex-pre-tool-use`, so each mode names the agent whose input it reads.
4. The `session-start` mode names the skill in a way every agent understands ("run `node .agents/skills/protected-branch-guard/scripts/start-work.mjs <slug> --base <branch>`") instead of the Codex `$start-work` syntax.
5. `start-work.mjs` drops the hard-coded `codex/` prefix, so the slug is the branch name, and takes the base branch as a required `--base <branch>` option. This repository's branch names start with the issue number (`AGENTS.md` requires the number in the name), and the slug grammar `^[a-z0-9]+(?:-[a-z0-9]+)*$` already admits a leading number.

Paths change too, without changing behavior: usage strings name `.agents/skills/protected-branch-guard/scripts/` instead of `protected-branch-guard/`.

### 8. The copy is linted, formatted, and tested with this repository

The payload files are source files of this repository like any other. They pass `pnpm lint` (Oxlint with `--deny-warnings`) and `oxfmt --check .` with no exemption, so `.prettierignore` is not extended to them, as it was for `packages/artifacts/hook-*/payload/**/*.mjs`. An exemption keeps this repository's checks quiet while shipping files that Vite+ rewrites in the project: `.vite-hooks/pre-commit` runs `vp staged`, which runs `vp check --fix` on every staged file, including `.agents/**`; an unformatted payload file is rewritten in the commit; its hash no longer matches the state record; and the next apply stops with the local-edits error from `assertSafeAiWrite`.

`guard.test.mjs` is not shipped, because every file in a skill payload travels into the project. It is ported to `packages/cli/scripts/`, runs in `pnpm test`, and gains a test for each change in Decision 7, including a rebase on a feature branch and a rebase of the protected branch. The `knip.json` entry `packages/artifacts/*/payload/**/*.mts` is widened to `packages/artifacts/*/payload/**`, because a payload `.mjs` file that no test imports, such as `start-work.mjs`, would otherwise be reported as an unused file. Separately, the Knip integration's generated `knip.json` ignores `.agents/**` in projects (#747), because installed scripts that nothing imports otherwise fail `quality`.

### 9. How C8 holds for the new writes

C8 is not weakened, and no C8 test changes. This ADR adds three write targets to apply, and each C8 property applies to them as follows.

- **Only the CLI writes into projects.** Apply writes the hook blocks and the settings entries. Neither the agent nor the person is asked to edit these files.
- **`dry_run_apply` is the approval boundary.** The dry run lists every new write with the text it adds (Decision 5), and apply writes nothing that the dry run did not show.
- **Local edits are preserved and never overwritten.** Apply writes only inside its own block or its own groups, keeps every other line and key, and stops when the person has edited its block or group.
- **Artifacts are not recorded in `package.json`.** Nothing here touches `package.json`.
- **Conflicts surface as a hard stop.** A missing marker, an edited block, an edited group, and an unparseable `.claude/settings.json` each stop apply before it writes.

`docs/ai-adapter-guidance.md` says Calavera "does not currently write `.claude/`". #745 changes that sentence to name the one file and the entries Calavera now writes.

### 10. Codex keeps a manual fragment

The payload ships `hooks/hooks.codex.json`, rewritten to call the `session-start` and `codex-pre-tool-use` modes with the branch argument. Calavera does not write `.codex/hooks.json` in this increment, because the owner's review asked for Claude Code and Codex project hooks load only after the person trusts the project's `.codex/` layer. `SKILL.md` tells the person to merge the fragment by hand, write the same branch name, and trust it in Codex with `/hooks`. Adding a `codex` member to `wiring` is a follow-up.

### 11. `agent-red-test-verification` is deferred

The owner ruled on 2026-10-23 to leave this gate out of Increment 1. The review above shows that it does not yet deliver what it promises. It prints its RED evidence and stores none, so no later step, reviewer, or CI job can check that a RED run happened. It accepts any non-zero exit, so a misspelled test path counts as evidence. It also asks every project to adopt two new conventions, `check-*.mjs` guardrails and `docs/acceptance/*.md` headings, before it does anything. #744 lists the gate with these findings and an adoption trigger: Calavera adopts it when the evidence is written to a file that a later step or CI verifies, and when the RED check requires the failure output to name the criterion. #746, the issue that would add `skill-red-test-verification`, waits for that trigger. "The selected Determinant gates" in H0 is the guard alone.

### 12. What happens to the other Determinant files

- `install.mjs` is not shipped. Apply replaces it: apply copies the files, records ownership, and writes the wiring. The installer would set `core.hooksPath` only when the key was unset, and it refuses to replace a different value (`install.mjs:43-46`), so on a `vp create` project, where `vp config` has already set the key, it exits before it writes anything. Its other jobs move elsewhere: it made the wrappers executable (not needed, because the dispatcher runs scripts with `sh -e`), merged `hooks.codex.json` (now manual, Decision 10), and copied `start-work/SKILL.md` (now the payload's own `SKILL.md`).
- The three `git-hooks/` wrappers are not shipped. The `viteHooks` lines replace them.
- `hooks.codex.json` is shipped as `hooks/hooks.codex.json` (Decision 10).
- `start-work/SKILL.md` becomes the payload's `SKILL.md`, renamed `protected-branch-guard`, with the limits in the Consequences section.
- `guard.test.mjs` is ported, not shipped (Decision 8).

### 13. The MCP registration is the bootstrap's `.mcp.json`

The H0 element "the MCP registration" is the `.mcp.json` that the bootstrap (`--init`, also run by `--new`) writes. The bootstrap writes that file only for the `claude-code` harness, and a bootstrap run with `--json`, `--yes`, or without a TTY skips the registration unless `--mcp-harness claude-code` is given. #748, the issue that extends the agent-first flow test to install the gate through the registry stand-in, asserts the bootstrap's registration. No recipe key is added. The agent flow cannot create its own registration, because the bootstrap prompt tells the agent to stop when the Calavera MCP tools are missing. A recipe key would also inherit the writer's two properties: a textual comparison, so a reformatted `.mcp.json` would be reported as `update` on every dry run, and replacement of the whole `calavera` entry, which would overwrite a local edit.

### 14. `deterministic-pnpm-install` is not cataloged

It has no script, so there is nothing for an artifact to install. Its content is `package.json` and `pnpm-workspace.yaml` fields, and no artifact kind can write either file; C8 forbids writing artifacts to `package.json`. `vp create` already writes the package manager pin, as `devEngines.packageManager` with `"onFail": "download"` in the scratch project's `package.json`. The tracking issue (#744) lists it with the owner's decision, and a documentation-only skill stays a later option.

### 15. Install steps

These steps assume a project that `vp create` scaffolded with Git and hooks, an apply that runs at the Git repository root, which is the workspace root in a `vite:monorepo` project, and no `fmt` options in the project's `vite.config.ts`. They also assume #669 is fixed, as the owner ruled it must be before the readiness check. Until it is, the commit in step 4 reformats the Calavera-written files that fail Oxfmt, such as `calavera.config.json` and the bootstrap's `.mcp.json`, and the textual comparisons then report those files as changed.

1. Confirm that `git config --get core.hooksPath` prints `.vite-hooks/_`.
2. Commit the scaffold on the branch that will be protected, if it has no commit yet, and then create a feature branch. The commit of step 4 would otherwise be refused, and `start-work.mjs` branches from the protected branch, so it needs at least one commit there.
3. Select `{ "id": "skill-protected-branch-guard" }` in the recipe's `ai` list. Answer the protected-branch prompt, or confirm the default the agent shows. Run `dry_run_apply` or `apply --dry-run`, review the listed files, approve, and run `apply_recipe` or `apply`. For this artifact Calavera writes `.agents/skills/protected-branch-guard/`, the guard blocks in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, its entries in `.claude/settings.json`, its lock, state, packages, cache, and transaction files under `.calavera/`, and `.coderabbit.yaml` when that file is missing or lacks Calavera's path filters. It saves the recipe, with the branch name, to `calavera.config.json` when `writeConfig` is true, the default. Calavera writes nothing to `package.json`, `.git/config`, `.codex/`, or `.claude/settings.local.json`.
4. Commit the result on the feature branch through the Vite+ pre-commit hook, which now runs the guard first. With the default formatter configuration, the hook leaves the payload unchanged, and a second dry run reports every Calavera file as `unchanged`. A project with its own `fmt` options can see the payload rewritten here; the Consequences section describes that case.
5. Optionally, for Codex, merge `hooks/hooks.codex.json` into `.codex/hooks.json` with the same branch name, and trust it with `/hooks`.

### 16. Owner rulings

The owner's review of 2026-10-23 replaced one ruling of 2026-10-22 and added three:

- Calavera writes the guard's lines into `.vite-hooks/*` through apply. This replaces the 2026-10-22 ruling that adding the lines by hand satisfies "installs the selected gates" for H0.
- Calavera asks for the protected branch, with the current branch as the default.
- Calavera wires the guard into Claude Code by merging owned entries into `.claude/settings.json`.
- `agent-red-test-verification` is deferred from Increment 1 (Decision 11).

The owner's review of #745 on 2026-10-31 added four rulings:

- The `inputs` and `wiring` schema of #745's first layer is the final shape.
- `apply_recipe` refuses an input the recipe does not record, and `dry_run_apply` returns the recipe with the value filled in (Decision 6).
- On a project whose Git hooks no Vite+ dispatcher runs, apply warns and does not stop. The warning says the guard's hooks will not run and names the remedy that fits the clone: `vp config` installs the dispatcher, `vp hooks enable` turns hooks back on after `vp hooks disable`, and a `core.hooksPath` that points elsewhere must be removed first, because `vp config` leaves it alone (`node_modules/vite-plus/docs/guide/commit-hooks.md`, vite-plus 1.4.0).
- Calavera formats the text of a rewritten JSON file in memory with the project's own `vp fmt` before the dry run (Decision 5, "Format"). The #669 ruling below still holds, because nothing is formatted after it is written.

These rulings of 2026-10-22 stand:

- The `.mcp.json` that the bootstrap writes satisfies "the MCP registration" for H0.
- The readiness check uses the `vite:monorepo` template, and `vite:library` is recorded as not exercised.
- #669 is fixed before the readiness check by having Calavera write files that already pass Oxfmt, never by running `vp fmt` over written files.
- The npm name `@schalkneethling/calavera-skill-protected-branch-guard` stands. The owner claims it before the release with Fledgling, the tool that claims npm package names and sets up trusted publishing for them.

## Consequences

The guard acts through two paths. The Git path runs where the Vite+ dispatcher is installed and the hook blocks are present, and it covers every commit and push, whoever makes it. The Claude Code path runs in any Claude Code session in the project and covers file edits through Claude Code's file tools, before any commit. An edit that Claude Code makes through its `Bash` tool, such as `sed -i`, is not covered by the Claude Code path, and it meets the Git path only when it is committed. The Codex path runs only after the person merges and trusts the fragment (Decision 10).

The Git path stops running in these cases:

- **A linked Git worktree without its own dispatcher.** `.vite-hooks/_` is ignored, so a linked worktree has no dispatcher by default, and Git runs no hook there: not the guard and not `vp staged`. That includes the worktrees agents create under `.claude/worktrees/` and the worktrees `start-work.mjs --worktree` creates. Running `vp config` in the worktree installs the dispatcher there, and the guard then runs, but `vp staged` then needs the worktree's own dependencies. The Claude Code path still runs in a Claude Code worktree, because its command uses `${CLAUDE_PROJECT_DIR}`, which points at the main checkout, and it judges the branch of each edited file's own working tree. A tracking issue for the Git-path gap is to be filed before #749 runs.
- **`VP_GIT_HOOKS=0`, `VITE_GIT_HOOKS=0`, or `HUSKY=0`** in the committing process, or exported from `~/.config/vite-plus/hooks-init.sh`, which switches hooks off for the whole machine.
- **`vp hooks disable`**, which unsets `core.hooksPath`, removes `.vite-hooks/_`, and records the choice in the clone so that `prepare` does not reinstall it.
- **`git push --no-verify`**, which skips `pre-push`.
- **`git rebase` with `rebase.backend=apply`**, which does not run `prepare-commit-msg` for the commits it replays.

The Determinant README already says these are accident guards and that server-side branch protection stays essential.

The scripts run on every commit, push, and Claude Code edit as the developer. That raises the stakes of #613 (a separate dry run and apply can install artifact versions that were never approved, because an unlocked artifact resolves its tag again): if a new version is published between the dry run and the apply, the code that runs at every commit is code the person never approved. Running the dry run and the apply minutes apart narrows the window but does not close it.

Because `.claude/settings.json` is committed, every collaborator's Claude Code runs the guard's hooks in this project. That is the intent, and the dry run shows the entries before they are written.

The payload is formatted for the Oxfmt version and defaults this repository uses. Today that is `oxfmt` 0.73.0, the same version vite-plus 1.2.0 installs. If the two versions format differently, or a project sets its own `fmt` options in `vite.config.ts`, the pre-commit hook rewrites the payload, and the next apply stops with the local-edits error. No recovery path exists for that stop: Calavera has no command that removes or reinstalls an artifact (#678, the issue for a command that removes Calavera's management files), and apply refuses the rewritten directory. What a person can do today is copy the shipped files back from the extracted payload under `.calavera/packages/<id>/<version>/`, which lets the next apply pass. The next commit that stages those files rewrites them again, until the project keeps `.agents/**` out of its `staged` patterns or the two Oxfmt versions agree.

Because no removal command exists (#678), a project that deletes the guard's skill directory but keeps the hook blocks makes every commit fail, because `node` cannot find the script and the dispatcher runs the hook with `sh -e`. When #678 lands, removing the artifact must remove its hook blocks and its settings groups too, because apply owns them.

The litmus test holds. Vite+ provides the hook dispatcher and `vp staged`, and the design uses both and writes only into the scripts Vite+ leaves to the project. The Vite+ commit-hooks guide describes no branch policy, so the guard adds to Vite+ rather than competes with it.

## Alternatives considered

**Depend on Determinant instead of copying.** Not possible, because Determinant publishes no package, and a dependency could not carry the changes in Decision 7.

**Ship the guard as a hook artifact.** Rejected. A hook artifact copies exactly `hook.mjs` and `settings-fragment.json`, so it cannot carry several scripts, and it would add another unchecked `targets` claim.

**Let Calavera set `core.hooksPath`.** Rejected by the litmus test. A successful write would make `vp config` skip its dispatcher and stop `vp staged`, and the write would land in `.git/config`, outside every record Calavera keeps. Running Determinant's `install.mjs` is not an alternative either: on a `vp create` project it refuses to replace the hooks path that `vp config` set and exits before it writes anything.

**Leave the hook lines to the person.** This was the first version of this decision. The owner's review rejected it: the scripts are in the project and meant to be edited, so Calavera can write the lines under the same dry-run approval as every other write, and a manual step is one a person can skip or get wrong.

**Replace the whole hook script, or the whole settings file.** Rejected by C8. Both files belong to the project and can hold other lines and entries, which a whole-file write would overwrite.

**Detect the default branch without asking.** Rejected. A fresh `vp create` repository has no remote, `git var GIT_DEFAULT_BRANCH` describes the machine, and `refs/remotes/origin/HEAD` appears only after a clone or a fetch. The current branch is a good default but not a choice until the person confirms it.

**Read the protected branch from a Git configuration key.** Rejected. `.git/config` is never committed, while the hook lines are. A key would make every fresh clone, every CI job, and every cloud sandbox refuse all commits until someone set it there, and `CI=true vp config` still installs the dispatcher, so CI jobs would run the guard. A wrong but valid value would protect nothing without any sign of it, and no reviewer could see it, because it lives outside the repository.

**Adopt `agent-red-test-verification` with fixes now.** Not chosen by the owner. The fixes that would make its evidence checkable are new design, not copy changes, and they belong after the gate's value is shown (Decision 11).

**Exempt the payloads from formatting with `.prettierignore`.** Rejected, because the exemption hides the problem in this repository and leaves it in every project. **Run `vp fmt` over Calavera's writes.** Rejected by the owner's #669 ruling, because managed-file and MCP-config comparisons are textual, and because a file formatted after the write holds bytes the dry run never showed. Formatting in memory before the dry run, as Decision 5 now does, has neither problem. **Call Oxfmt's `format` function, which `vite-plus/fmt` exports.** Rejected, because it reads no configuration, so a project with its own `fmt` settings would still fail `vp check`.

**Add an `mcp.harness` recipe key.** Rejected for Decision 13's reasons.

**Catalog `deterministic-pnpm-install` as a documentation-only skill.** Not chosen for H0. The tracking issue (#744) keeps it as a later option.

## Open questions

- **The worktree gap.** Whether the Git path should run in linked worktrees, and how, given that `vp config` there also needs the worktree's dependencies, is not decided. The Consequences section records the gap.
- **Projects with their own formatter options.** The files Calavera rewrites now follow the project's `fmt` options (Decision 5). The copied payload under `.agents/skills/` does not: `vp staged` can rewrite it in the first commit, and the next apply then reports a local edit. Whether the project should exclude `.agents/**` from `staged` is not decided.
- **Codex wiring.** Whether `wiring` gains a `codex` member that writes `.codex/hooks.json` is a follow-up (Decision 10).
