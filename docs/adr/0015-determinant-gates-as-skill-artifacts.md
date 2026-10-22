# ADR-0015: Determinant Gates as Calavera Artifacts in a Vite+ Project

- **Status:** Proposed (2026-10-22)
- **Date:** 2026-10-22
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/743
- **Decides:** how the two Determinant gates of Increment 1, `protected-branch-guard` and `agent-red-test-verification`, reach a project that `vp create` scaffolded.
  - Both gates are copied into skill artifacts, which Calavera's existing artifact path installs. For these artifacts, apply writes the two skill directories under `.agents/skills/` and its own records under `.calavera/`. As for any recipe with a skill, it also writes `.coderabbit.yaml` when that file is missing or lacks Calavera's path filters, and it saves the recipe to `calavera.config.json` when `writeConfig` is true, which is the default.
  - Calavera never sets `core.hooksPath`. The guard's Git layer is three lines the person adds by hand to the project-owned `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push` scripts.
  - The guard does not compare against `main`. The person names the protected branch as an argument in those committed lines.
  - None of the C8 safety properties (`docs/evolution-brief.md`, Section 3) changes.

## Context

The Increment 1 exit condition, handoff H0, says the agent-first flow "installs repository controls, governance and drift checks, EditorConfig, Knip, the selected Determinant gates, and the MCP registration" on a fresh `vp create` library monorepo (`docs/cross-repo/sequencing-map.md:14`). Section 0 of the same file names the first slice: catalog `protected-branch-guard` and `agent-red-test-verification` "as artifacts from their current scripts", add `deterministic-pnpm-install` only "if the existing artifact path carries it without a schema change", and treat a gate that metadata cannot express as "a request, not a blocker" (`docs/cross-repo/sequencing-map.md:23`).

Determinant is a collection of copy-paste scenarios in https://github.com/schalkneethling/determinant, under the MIT license and the same owner as Calavera. It publishes no package. This ADR reads it at commit `9382bbc`.

- `protected-branch-guard` refuses a commit on `main` and a push to `main`. It has `guard.mjs` and `lib.mjs` (the policy, with `commit`, `pre-push`, `session-start`, `pre-tool-use`, and `check` modes), `start-work.mjs` (creates a work branch from `main`), three Git hook wrappers under `git-hooks/`, `hooks.codex.json` (Codex `SessionStart` and `PreToolUse` hooks), `start-work/SKILL.md`, `install.mjs`, and `guard.test.mjs`. The only protected ref is the literal `refs/heads/main` (`lib.mjs:26`, `guard.mjs:92`).
- `agent-red-test-verification` asks for RED evidence: proof that a test for an acceptance criterion fails before the change that should make it pass. It is a four-step lifecycle of `agent-preflight.mjs`, `agent-verify-red.mjs`, `agent-verify-changed.mjs`, and `agent-handoff.mjs`, which share `lib/agent-lifecycle.mjs`. `agent-verify-red.mjs` requires a criterion declared as a `## AC-AREA-NNN` heading in `docs/acceptance/*.md` and then requires the given test command to fail. Every step first runs the project's guardrails, the `check-*.mjs` scripts, and refuses when there are none.
- `deterministic-pnpm-install` has three example files (`package.example.json`, `pnpm-workspace.example.yaml`, `ci.example.yml`) and no script.

Two rules in `docs/evolution-brief.md` pull against each other here. The litmus test (C1) says Calavera steps aside wherever it would fight Vite+, and Vite+ owns the Git hooks of every `vp create` project. C8 says only the CLI writes into projects, so a manual step is not a Calavera write, and an agent that edits project files on the person's behalf is not the CLI either. This ADR resolves the conflict by keeping every Calavera write inside the existing artifact path and leaving the hook wiring to the person.

## Evidence

The evidence comes from Calavera's code at `origin/main` (`99242ec`), from the Determinant clone at `9382bbc`, and from probes run on 2026-10-22 with vite-plus 1.2.0, Git 2.55.0, and Node.js 24.22.1. The Git probes ran in a fresh `git init` repository under the scratchpad that holds a copy of a scratch `vp create vite:monorepo` project's files and installed dependencies. The machine has no `init.defaultBranch` setting, so the repository started on `master`. Commit signing stayed on: the probe repository's local `user.signingkey` is the key this project's own repository uses, and every probe commit carries an SSH signature.

**`vp config` sets `core.hooksPath`, in CI too.** In the fresh repository, `git config --get core.hooksPath` exited 1. `CI=true node node_modules/vite-plus/bin/vp config` exited 0, and the local configuration then held `core.hookspath=.vite-hooks/_`, `vp.hooks.dir=.vite-hooks`, and `vp.hooks.prefix=.`, with the dispatcher installed under `.vite-hooks/_/`. The scaffold's `package.json` runs this on every install as `"prepare": "vp config"`, and `vp create --help` lists `--hooks` as "Set up pre-commit hooks (default in non-interactive mode)". The bundled guide (`node_modules/vite-plus/docs/guide/commit-hooks.md`) adds two facts that matter here: "If `core.hooksPath` points to another hook directory, `vp config` skips dispatcher installation", and project-owned scripts such as `.vite-hooks/pre-commit` "should be committed to the repository", while the dispatcher under `.vite-hooks/_` is ignored and recreated. Neither `vp config` nor `vp hooks` "creates or modifies project hook scripts". No file in `packages/cli/src` or `packages/artifact-core/src` mentions `hooksPath` or `.vite-hooks`.

**How the dispatcher runs a project hook.** `vp config` creates `.vite-hooks/_/` with a `.gitignore` containing `*`, one shim per Git hook (each sources `h`), and the shared script `h`. `h` exits 0 when `.vite-hooks/<hook>` does not exist, sources `~/.config/vite-plus/hooks-init.sh` (or `~/.config/husky/init.sh`) when present, exits 0 when `HUSKY`, `VP_GIT_HOOKS`, or `VITE_GIT_HOOKS` is `0`, prepends `node_modules/.bin` to `PATH`, and runs the project-owned script with `sh -e`, so the script needs no executable bit and stops at its first failing line. The scaffold's `.vite-hooks/pre-commit` holds one line, `vp staged`, and its `vite.config.ts` sets `staged: { "*": "vp check --fix" }`.

**The guard works through the dispatcher, and the first line runs first.** The Determinant `guard.mjs` and `lib.mjs` were copied to `.agents/skills/protected-branch-guard/scripts/`. `.vite-hooks/pre-commit` was rewritten to hold `node .agents/skills/protected-branch-guard/scripts/guard.mjs commit` followed by `vp staged`. The same `commit` line went into a new `.vite-hooks/prepare-commit-msg`, and `node .agents/skills/protected-branch-guard/scripts/guard.mjs pre-push` into a new `.vite-hooks/pre-push`. On a branch named `main`, with an unformatted file staged, `git commit -m "on main"` exited 1 with "Protected branch guard: … main is read-only. Create or switch to a named feature branch before editing or committing." followed by "VITE+ - pre-commit script failed (code 1)". `vp staged` printed nothing, and the staged file stayed unformatted, so the guard refused before any file was rewritten. `git push origin main` to a local bare remote exited 1 with "Push to main refused (including force updates and deletion)". The guard reads Git's ref records from standard input and skips empty input, so that refusal also shows that the dispatcher passes the records through. `git push origin master` exited 0, which shows that the unmodified guard protects only the literal `main`. The `git commit --no-verify` case was not rerun for this ADR; the Determinant README states that `prepare-commit-msg` still runs under `--no-verify`, and `guard.test.mjs:52-56` covers it.

**The guard takes exactly one argument today.** `node .agents/skills/protected-branch-guard/scripts/guard.mjs commit master` exited 1 with "Protected branch guard: Usage: node protected-branch-guard/guard.mjs commit|pre-push|session-start|pre-tool-use|check", because `guard.mjs:116` refuses any `process.argv` length other than 3.

**`vp staged` rewrites unformatted payload files.** The commit that added the two scripts on `master`, which the unmodified guard does not protect, ran `vp check --fix` over the five staged files and exited 0. It changed the SHA-256 of `guard.mjs` from `a8fd0844…` to `d37c57d6…` and of `lib.mjs` from `1673d4b1…` to `95db4414…`, and the committed files grew from 145 and 43 lines to 159 and 49. In Calavera, an installed skill whose hash matches neither its source nor its state record makes the next apply stop with "Refusing to overwrite existing AI artifact: <path>. It appears to have local edits" (`assertSafeAiWrite`, `packages/cli/src/ai/artifacts.js:443-473`). Running this repository's `oxfmt` 0.73.0 with `--write` and no configuration on fresh copies of the two files produced the same two hashes, and vite-plus 1.2.0 installs `oxfmt@0.73.0` in the copy's `node_modules/.pnpm`. `oxfmt --check` on the candidate payloads described below reported four files: `hooks/hooks.codex.json`, `scripts/guard.mjs`, `scripts/lib.mjs`, and `scripts/start-work.mjs`. The red-test verification scripts passed unchanged. The existing hook payload `packages/artifacts/hook-block-dangerous-commands/payload/block-dangerous-commands/hook.mjs`, which `.prettierignore` exempts, fails `oxfmt --check` too.

**Ways the guard stops running.** On `main`, `VITE_GIT_HOOKS=0`, `HUSKY=0`, and `VP_GIT_HOOKS=0` each let `git commit` exit 0 with a signed commit. `vp hooks disable` printed "unset core.hooksPath (was ".vite-hooks/_"); removed .vite-hooks/_", the next commit on `main` exited 0, and a later `vp config` printed "skip install (hooks disabled; run `vp hooks enable` to re-enable)" and left `core.hooksPath` unset, because `disable` records `vp.hooks.disabled=true` in the clone's Git configuration.

**A linked worktree runs no hook.** `git worktree add --detach` created a worktree whose `.vite-hooks/` held `pre-commit`, `pre-push`, and `prepare-commit-msg` but no `_`, because `_` is ignored. `core.hooksPath` still read `.vite-hooks/_`, which Git resolves inside that worktree. A commit there on a detached HEAD, which the guard refuses, exited 0 with no `vp staged` output, and the unformatted file it added stayed unformatted. Running `vp config` inside the linked worktree created `.vite-hooks/_` there. The guard then ran and refused the detached HEAD. On a branch in the same worktree, the guard passed and `vp staged` failed with "Cannot find package 'vite-plus'", because the worktree had no installed dependencies. The scaffold's `.gitignore` lists `.claude/worktrees/` under "AI agent worktrees", so the worktrees agents create are linked worktrees of this kind.

**What Git records about the default branch.** `git var GIT_DEFAULT_BRANCH` printed `master`, the name Git gives new repositories on this machine, not a property of the repository. After `git push`, `refs/remotes/origin/HEAD` did not exist. After `git fetch`, it pointed to `refs/remotes/origin/master`, taken from the bare remote's own `HEAD`. A repository without a remote, which is what `vp create --git` produces, records no default branch at all.

**The RED gate accepts any non-zero exit.** In `packages/utils` of a copy of the scratch project, `vp test run tests/definitely-missing.test.ts` printed "No test files found, exiting with code 1" and exited 1. With a guardrail that exits 0 and `docs/acceptance/probe.md` declaring `## AC-PROBE-001`, `node agent-verify-red.mjs --criterion AC-PROBE-001 -- vp test run tests/definitely-missing.test.ts` exited 0 with "RED evidence captured for AC-PROBE-001". `runExpectedFailure` (`agent-red-test-verification/lib/agent-lifecycle.mjs:20-40`) rejects only exit 0 and a signal.

**SkillSpector passes both candidate payloads, which are not final.** The candidate payloads were built in the scratchpad from the Determinant files at `9382bbc` in the layouts planned by #745 (the issue that adds the `skill-protected-branch-guard` artifact) and #746 (the issue that adds the `skill-red-test-verification` artifact). They hold the first three script changes of Decision 6, a draft `SKILL.md`, the hook fragment, and `SOURCE.md`. They are not formatted by Oxfmt and lack the branch argument of Decision 5. `uv run --frozen skillspector scan <payload> --no-llm`, run from this repository with SkillSpector 2.3.13 (the commit `pyproject.toml` pins), exited 0 for each, with "No security issues detected", a risk score of 0/100, and seven components each. The report typed every `.mjs` file as `other` and "Executable: No", so a clean scan says little about what the scripts do when they run. #745 and #746 must scan their final payloads again.

**Calavera's artifact path.** The schema allows three kinds, `skill`, `hook`, and `agent` (`packages/cli/schemas/calavera-artifact.schema.json:22`), and forbids `targets` on a skill (`:55-60`). A skill installs to `.agents/skills/<name>/` (`packages/cli/src/ai/artifacts.js:233-236`) as a recursive copy of its whole payload directory (`:410-414`). A hook copies exactly `hook.mjs` and `settings-fragment.json` (`:37`, `:419-426`). Any skill in a recipe also plans `.coderabbit.yaml`, as a `write` when the file is missing and as an `update` when it lacks Calavera's path filters (`:65-105`, `:483`, `:557-571`). The artifact lifecycle keeps its lock, state, extracted packages, cache, and transactions under `.calavera/` (`packages/cli/src/artifact-lifecycle.js:25-30`). The MCP tools `dry_run_apply` and `apply_recipe` default `writeConfig` to true (`packages/cli/src/mcp.js:244`, `:261`). Calavera never merges a settings fragment: the hook pointer tells the person to review `settings-fragment.json` "before wiring them into agent settings" (`artifacts.js:544`), and `docs/ai-adapter-guidance.md:27` says Calavera "does not currently write `.claude/`, `.codex/`, editor settings, global agent directories, symlinks, or machine-local configuration". Recipes select artifacts by ID, as in `{ "id": "skill-project-goal" }` (`README.md`, "Versioned artifacts"; `packages/cli/src/ai/recipe-items.js:46-53`).

**The MCP registration.** The bootstrap's next prompt tells the agent to "verify that the Calavera MCP tools are available" and, if they are not, to "stop and help me configure the MCP server before composing or applying anything" (`packages/cli/src/index.js:250-251`). The bootstrap writes `.mcp.json` only for the `claude-code` harness; the other harnesses map to `.codex/config.toml`, `.cursor/mcp.json`, and `opencode.json` (`packages/cli/src/utils/mcp-config.js:303-316`). Without `--mcp-harness`, `resolveAgentBootstrapMcpHarness` returns `skip` under `--json`, `--yes`, or a standard input that is not a TTY (`packages/cli/src/index.js:2959-2966`). The project JSON writer compares text, `currentContents === nextContents` (`mcp-config.js:66-97`), and replaces the whole `mcpServers.calavera` entry (`:118-138`).

## Decision

### 1. Copy the scripts and record their source in `SOURCE.md`

Calavera copies the Determinant scripts into two artifact packages and does not depend on Determinant. Determinant publishes nothing, so there is no version to pin, and the copies need changes (Decisions 5 and 6) that a pin could not carry. Each payload holds a `SOURCE.md` that names `schalkneethling/determinant@9382bbc`, the folder it came from, and every changed line, so a later comparison with upstream starts from a known point. The artifact package is the versioned unit a project updates through `artifacts update`.

### 2. Both gates are skill artifacts

The packages are `@schalkneethling/calavera-skill-protected-branch-guard` and `@schalkneethling/calavera-skill-red-test-verification`, with the IDs `skill-protected-branch-guard` and `skill-red-test-verification`. A skill copies its whole payload directory, so it can carry `SKILL.md`, the scripts, and the fragments together. A hook artifact copies only `hook.mjs` and `settings-fragment.json`, which cannot carry a set of scripts. A skill also has no `targets` list, so this decision does not widen the four targets that every hook artifact claims without a check (`packages/artifact-core/src/catalog.js:8`).

### 3. Calavera never sets `core.hooksPath`

`vp config` sets `core.hooksPath` to `.vite-hooks/_` in every clone through the `prepare` script. If Calavera set it to another directory, `vp config` would skip installing the dispatcher, and `vp staged` would stop running before every commit. That is the fight with Vite+ that the litmus test forbids. The key also lives in `.git/config`, which is not a project file Calavera tracks: no state record, hash, dry-run change, or `clean` covers it. Determinant's own installer avoids the same fight: it sets `core.hooksPath` only when the key is unset and refuses to replace a different value (`install.mjs:43-46`), so it refuses on a `vp create` project, where `vp config` has already set the key. Calavera writes no Git configuration at all, and the `viteHooks` metadata field that could one day let apply add the lines (Decision 4) would still leave `core.hooksPath` to Vite+.

### 4. The Git layer is three lines the person adds

The guard's Git layer is three one-line additions to project-owned scripts that the dispatcher runs. `<branch>` is the protected branch (Decision 5).

- `.vite-hooks/pre-commit`: `node .agents/skills/protected-branch-guard/scripts/guard.mjs commit <branch>`, as the first line, before `vp staged`, so the guard refuses before any staged file is rewritten.
- `.vite-hooks/prepare-commit-msg`: the same `commit` line. This file does not exist in the scaffold. It is the backstop for `git commit --no-verify`, which skips `pre-commit` but not `prepare-commit-msg`.
- `.vite-hooks/pre-push`: `node .agents/skills/protected-branch-guard/scripts/guard.mjs pre-push <branch>`. This file does not exist in the scaffold either.

The payload ships these lines in `hooks/vite-hooks.fragment.md`, and `SKILL.md` repeats the instruction. This is the pattern the hook artifacts already follow with `settings-fragment.json`: Calavera copies the fragment, and the person wires it. The person commits the three files, as the Vite+ guide asks for project-owned scripts, so the wiring reaches every clone. An agent does not make these edits on the person's behalf, because an agent edit is not a CLI write under C8. A `viteHooks` metadata field that would let apply write a marked line stays a follow-up.

### 5. The protected branch is an argument in the committed hook lines

The guard does not compare against a literal `main`, does not detect the default branch, and reads no Git configuration. The person writes the protected branch name as the last argument of every guard command: the `commit` and `pre-push` lines of Decision 4, and the `session-start` and `pre-tool-use` commands in the Codex fragment. The lines are committed, so every clone and every CI job reads the same name, and a reviewer sees it.

This needs a change to the copy, because `guard.mjs` accepts exactly one argument today (`guard.mjs:116`), and a hook line with a second argument would refuse every commit with the usage message. The copy accepts `<mode> <branch>`, checks the name with `git check-ref-format --branch`, and passes it to `assertWritableBranch` (`lib.mjs:24-30`), to the push check (`guard.mjs:92`), and to the session notice (`guard.mjs:103`, `:107`), which today compare against `refs/heads/main`. A missing, empty, or invalid argument is an error: the `commit`, `check`, and `pre-push` modes exit non-zero, `pre-tool-use` denies, and `session-start` reports it, each with a message that names the line to fix and shows its correct form. `start-work.mjs` hard-codes `refs/heads/main` and `refs/remotes/origin/main` (`start-work.mjs:17-18`); the copy takes the base branch as a required `--base <branch>` option, and `SKILL.md` tells the agent to use the branch that the `.vite-hooks/pre-commit` line names.

A misspelled branch name protects nothing, as any wrong value would. In a committed hook line, the mistake is visible in review and is the same in every clone.

Detection was rejected, because a repository that `vp create --git` produces has no remote and records no default branch. The other candidates describe something else: `git var GIT_DEFAULT_BRANCH` is the name this machine gives new repositories, and `refs/remotes/origin/HEAD` exists only after a clone or a fetch and follows whatever the remote's `HEAD` says. A protected branch that changes when a fetch runs is not one anyone chose. A Git configuration key was rejected too (see Alternatives considered).

The readiness check records which branch name it passes to the guard. It does not need to rename `master`, because the guard compares against the name the lines carry.

### 6. The changes to the copied scripts

The copies change four behaviors, and each payload's `SOURCE.md` lists its changes. The first three are upstream findings for Determinant in #744, the tracking issue for the Determinant gates that are not shipped in this increment; the fourth, the literal `main`, is not in that list yet.

1. `start-work.mjs` drops the hard-coded `codex/` prefix (`start-work.mjs:15`), so the slug is the branch name. A fixed `codex/` prefix names one agent instead of the work, and this repository's branch names start with the issue number (`AGENTS.md` requires the number in the name). The slug grammar `^[a-z0-9]+(?:-[a-z0-9]+)*$` already admits a leading number.
2. Guardrail discovery in `lib/agent-lifecycle.mjs` uses the project's `scripts/` directory relative to the working directory, not the directory beside the scripts (`lib/agent-lifecycle.mjs:6`, `:43`). Beside the scripts is inside the Calavera-owned skill directory, where a project guardrail would change the directory hash and the next apply would refuse it as a local edit. The Determinant README already prescribes a repository `scripts/` directory (`agent-red-test-verification/README.md:9-12`).
3. `agent-verify-changed.mjs` runs `node --run quality` instead of the hard-coded `pnpm test` and `pnpm run typecheck` (`agent-verify-changed.mjs:3`). `quality` is the gate script ADR-0013 defines for a Calavera project, and `node --run` runs a `package.json` script without the gate choosing a package manager. It reads the `package.json` in the working directory, so the scripts run from the workspace root.
4. The guard and `start-work.mjs` take the protected branch as an argument, as Decision 5 says.

Paths change too, without changing behavior: usage strings and the Codex fragment name `.agents/skills/protected-branch-guard/scripts/` instead of `protected-branch-guard/`.

### 7. What happens to the other Determinant files

- `install.mjs` is not shipped. Calavera's apply replaces it: apply copies the files and records ownership, and the person does the wiring. The installer refuses to replace a `core.hooksPath` that points elsewhere, so it refuses on every `vp create` project, and that refusal is correct under Vite+. Its other jobs move elsewhere: it set `core.hooksPath` when the key was unset (never done, Decision 3), made the wrappers executable (not needed, because the dispatcher runs scripts with `sh -e`), merged `hooks.codex.json` (now manual), and copied `start-work/SKILL.md` (now the payload's own `SKILL.md`).
- The three `git-hooks/` wrappers are not shipped. The fragment lines in Decision 4 replace them.
- `hooks.codex.json` is shipped as `hooks/hooks.codex.json`, with its command paths rewritten to `.agents/skills/protected-branch-guard/scripts/guard.mjs` and a `<branch>` argument on each command. The person merges it by hand into `.codex/hooks.json`, writes the same branch name as in the hook lines, and trusts it in Codex with `/hooks`, as the Determinant README already instructs. Calavera does not write `.codex/hooks.json`.
- The `codex/` branch prefix is removed (Decision 6).
- `start-work/SKILL.md` becomes the payload's `SKILL.md`, renamed `protected-branch-guard`, with the wiring instructions and the limits in the Consequences section.
- `guard.test.mjs` and `agent-verify-red.test.mjs` are not shipped, because every file in a skill payload travels into the project. They are ported to `packages/cli/scripts/` (#745, #746).
- The example `docs/acceptance/search.md` is not shipped. `SKILL.md` documents the heading grammar instead, because acceptance documents are the project's own.

### 8. Payload files ship already formatted by Oxfmt

Every payload file, scripts and JSON alike, is committed in the form Oxfmt produces with no configuration. The chain this prevents is the one the probe showed: `.vite-hooks/pre-commit` runs `vp staged`, which runs `vp check --fix` on every staged file, including `.agents/**`; an unformatted payload file is rewritten in the commit; its hash no longer matches the state record; and the next apply stops with the local-edits error from `assertSafeAiWrite`.

Calavera does not extend `.prettierignore` to these payloads, as it did for `packages/artifacts/hook-*/payload/**/*.mjs`. An exemption keeps this repository's `oxfmt --check .` quiet while shipping files that Vite+ rewrites in the project, which is the state of the existing hook payloads today. Calavera does not run `vp fmt` over the files it writes either, because managed-file and MCP-config comparisons are textual (#669, the issue reporting that Calavera-generated configuration, `AGENTS.md`, and repository-controls documentation fail `vp fmt --check` in Vite+ projects).

The repository configuration changes this needs belong to the guard artifact (#745): `.prettierignore` stays unchanged, and the `knip.json` entry `packages/artifacts/*/payload/**/*.mts` is widened to `packages/artifacts/*/payload/**`, because a payload `.mjs` file that no test imports, such as `start-work.mjs`, would otherwise be reported as an unused file. Separately, the Knip integration's generated `knip.json` ignores `.agents/**` in projects (#747), because installed scripts that nothing imports otherwise fail `quality`.

### 9. No Claude Code coverage is claimed

No Claude Code wiring exists for either gate, and this ADR claims none. Determinant's `protected-branch-guard` has a Codex adapter and no Claude Code adapter. `hook-block-dangerous-commands` is not in the recipe of #749, the bootstrap readiness check on a scratch `vp create vite:monorepo` project, and even when it is installed, Calavera never wires its `settings-fragment.json` into `.claude/settings.json`. The guard acts at Git commit and push time only. A commit that Claude Code makes through Git meets the same hooks as any other commit, which is Git's coverage, not a Claude Code integration, and in a Claude Code worktree under `.claude/worktrees/` the hooks do not run at all. An edit-time adapter is a follow-up.

### 10. The MCP registration is the bootstrap's `.mcp.json`

The H0 element "the MCP registration" is the `.mcp.json` that the bootstrap (`--init`, also run by `--new`) writes. The bootstrap writes that file only for the `claude-code` harness, and a bootstrap run with `--json`, `--yes`, or without a TTY skips the registration unless `--mcp-harness claude-code` is given. #748, the issue that extends the agent-first flow test to install both gate skills through the registry stand-in, asserts the bootstrap's registration. No recipe key is added. The agent flow cannot create its own registration, because the bootstrap prompt tells the agent to stop when the Calavera MCP tools are missing. A recipe key would also inherit the writer's two properties: a textual comparison, so a reformatted `.mcp.json` would be reported as `update` on every dry run, and replacement of the whole `calavera` entry, which would overwrite a local edit.

### 11. `deterministic-pnpm-install` is not cataloged

It has no script, so there is nothing for an artifact to install. Its content is `package.json` and `pnpm-workspace.yaml` fields, and no artifact kind can write either file; C8 forbids writing artifacts to `package.json`. `vp create` already writes the package manager pin, as `devEngines.packageManager` with `"onFail": "download"` in the scratch project's `package.json`. The tracking issue (#744) lists it with the owner's decision, and a documentation-only skill stays a later option.

### 12. Install steps

These steps assume a project that `vp create` scaffolded with Git and hooks, and an apply that runs at the Git repository root, which is the workspace root in a `vite:monorepo` project. They also assume #669 is fixed, as the owner ruled it must be before the readiness check. Until it is, the commit in step 4 reformats the Calavera-written files that fail Oxfmt, such as `calavera.config.json` and the bootstrap's `.mcp.json`, and the textual comparisons then report those files as changed.

1. Confirm that `git config --get core.hooksPath` prints `.vite-hooks/_`.
2. Commit the scaffold on the branch that will be protected, if it has no commit yet, and then create a feature branch. `start-work.mjs` branches from the protected branch and needs at least one commit on it (`start-work.mjs:17`).
3. Select `{ "id": "skill-protected-branch-guard" }` and `{ "id": "skill-red-test-verification" }` in the recipe's `ai` list, run `dry_run_apply` or `apply --dry-run`, approve, and run `apply_recipe` or `apply`. For these artifacts Calavera writes `.agents/skills/protected-branch-guard/`, `.agents/skills/red-test-verification/`, its lock, state, packages, cache, and transaction files under `.calavera/`, and `.coderabbit.yaml` when that file is missing or lacks Calavera's path filters. It saves the recipe to `calavera.config.json` when `writeConfig` is true, the default. Calavera writes nothing to `package.json`, `.vite-hooks/`, `.git/config`, `.codex/`, or `.claude/`.
4. Commit the result on the feature branch through the Vite+ pre-commit hook. Because the payloads ship formatted, the hook leaves them unchanged, and a second dry run reports both skills as `unchanged`.
5. Add the three lines of Decision 4, each ending with the protected branch name, to `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and commit them on the feature branch. Until this step, the guard is installed but no Git hook calls it.
6. Optionally, for Codex, merge `hooks/hooks.codex.json` into `.codex/hooks.json` with the same branch name, and trust it with `/hooks`.
7. For the RED gate, add at least one guardrail, `scripts/check-<name>.mjs`, and an acceptance document, `docs/acceptance/<name>.md`, with `## AC-AREA-NNN` headings. Run the four scripts from the project root as `node .agents/skills/red-test-verification/scripts/<script>.mjs`.

### 13. Rulings the owner made on 2026-10-22

These rulings are recorded here and are not reopened by this ADR.

- Adding the three Git-hook lines by hand satisfies "installs the selected gates" for H0.
- The `.mcp.json` that the bootstrap writes satisfies "the MCP registration" for H0.
- The readiness check uses the `vite:monorepo` template, and `vite:library` is recorded as not exercised.
- #669 is fixed before the readiness check by having Calavera write files that already pass Oxfmt, never by running `vp fmt` over written files.
- The npm names `@schalkneethling/calavera-skill-protected-branch-guard` and `@schalkneethling/calavera-skill-red-test-verification` stand. The owner claims them before the release with Fledgling, the tool that claims npm package names and sets up trusted publishing for them.

## Consequences

The guard is active only where the Vite+ dispatcher is installed and the three lines are present. It stops running in these cases:

- **A linked Git worktree.** `.vite-hooks/_` is ignored, so a linked worktree has no dispatcher, and Git runs no hook there: not the guard and not `vp staged`. That includes the worktrees agents create under `.claude/worktrees/` and the worktrees `start-work.mjs --worktree` creates. Running `vp config` in the worktree installs the dispatcher there, but `vp staged` then needs the worktree's own dependencies. A tracking issue for this gap is to be filed before #749 runs.
- **`VP_GIT_HOOKS=0`, `VITE_GIT_HOOKS=0`, or `HUSKY=0`** in the committing process, or exported from `~/.config/vite-plus/hooks-init.sh`, which switches hooks off for the whole machine.
- **`vp hooks disable`**, which unsets `core.hooksPath`, removes `.vite-hooks/_`, and records the choice in the clone so that `prepare` does not reinstall it.
- **`git push --no-verify`**, which skips `pre-push`. The Determinant README already says these are accident guards and that server-side branch protection stays essential.

The scripts run on every commit and push as the developer. That raises the stakes of #613 (a separate dry run and apply can install artifact versions that were never approved, because an unlocked artifact resolves its tag again): if a new version is published between the dry run and the apply, the code that runs at every commit is code the person never approved. Running the dry run and the apply minutes apart narrows the window but does not close it.

A guard line without a branch name refuses every commit or push it guards, with a message that names the fix. Because the name travels in committed files, a fresh clone, a CI job, and a cloud sandbox need no extra step.

The payloads are formatted for the Oxfmt version and defaults this repository uses. Today that is `oxfmt` 0.73.0, the same version vite-plus 1.2.0 installs. If the two versions format differently, or a project sets its own `fmt` options in `vite.config.ts`, the pre-commit hook rewrites the payloads, and the next apply stops with the local-edits error. No recovery path exists for that stop: Calavera has no command that removes or reinstalls an artifact (#678, the issue for a command that removes Calavera's management files), and apply refuses the rewritten directory. What a person can do today is copy the shipped files back from the extracted payload under `.calavera/packages/<id>/<version>/`, which lets the next apply pass. The next commit that stages those files rewrites them again, until the project keeps `.agents/**` out of its `staged` patterns or the two Oxfmt versions agree.

The RED gate accepts any non-zero exit as RED evidence, so a misspelled test path counts. `SKILL.md` tells the agent to read the failure output and confirm it is the intended failure, and the tracking issue (#744) records the limitation as an upstream finding. The gate refuses until the project adds its first guardrail, by design.

Because no removal command exists (#678), a project that deletes the guard's skill directory but keeps the three lines makes every commit fail, because `node` cannot find the script and the dispatcher runs the hook with `sh -e`.

The C8 safety properties are unchanged. Only the CLI writes into projects: apply writes the skills, and the person writes `.vite-hooks/*` and `.codex/hooks.json`. `dry_run_apply` remains the approval boundary, and it lists both skill directories. Local edits are preserved: an edit or a reformat inside a skill directory is refused on the next apply. Artifacts are not written to `package.json`. Conflicts still surface as a hard stop.

The litmus test holds. Vite+ provides the hook dispatcher and `vp staged`, and the design uses both. The Vite+ commit-hooks guide describes no branch policy and no check that a test failed before it passed, so the gates add to Vite+ rather than compete with it.

## Alternatives considered

**Depend on Determinant instead of copying.** Not possible, because Determinant publishes no package, and a dependency could not carry the changes in Decisions 5 and 6.

**Ship the gates as hook artifacts.** Rejected. A hook artifact copies exactly `hook.mjs` and `settings-fragment.json`, so it cannot carry several scripts, and it would add two more unchecked `targets` claims.

**Let Calavera set `core.hooksPath`, or run `install.mjs`.** Rejected by the litmus test. Either would make `vp config` skip its dispatcher and stop `vp staged`, and the write would land in `.git/config`, outside every record Calavera keeps.

**Let apply write the lines into `.vite-hooks/*` now.** Deferred by the owner. It needs a `viteHooks` metadata field with an ownership model for one marked line in a project-owned file, the way `AGENTS.md` carries a marked block today. Until that field exists, the manual step is the documented path.

**Detect the default branch.** Rejected for Decision 5's reasons: a fresh `vp create` repository has no remote, `git var GIT_DEFAULT_BRANCH` describes the machine, and `refs/remotes/origin/HEAD` appears only after a clone or a fetch.

**Read the protected branch from a Git configuration key.** Rejected. `.git/config` is never committed, while the hook lines are. A key would make every fresh clone, every CI job, and every cloud sandbox refuse all commits until someone set it there, and `CI=true vp config` still installs the dispatcher, so CI jobs would run the guard. A wrong but valid value would protect nothing without any sign of it, and no reviewer could see it, because it lives outside the repository.

**Exempt the payloads from formatting with `.prettierignore`.** Rejected, because the exemption hides the problem in this repository and leaves it in every project. **Run `vp fmt` over Calavera's writes.** Rejected by the owner's #669 ruling, because managed-file and MCP-config comparisons are textual.

**Add an `mcp.harness` recipe key.** Rejected for Decision 10's reasons.

**Catalog `deterministic-pnpm-install` as a documentation-only skill.** Not chosen for H0. The tracking issue (#744) keeps it as a later option.

## Open questions

- **The worktree gap.** Whether the guard should run in linked worktrees, and how, given that `vp config` there also needs the worktree's dependencies, is not decided. The Consequences section records the gap.
- **The `viteHooks` field.** The follow-up that would let apply write the three lines is to be filed.
- **A Claude Code edit-time adapter.** A `PreToolUse` adapter for edits on the default branch would need a new guard mode. It is to be filed as a follow-up.
- **Projects with their own formatter options.** Whether Calavera should detect `fmt` options in `vite.config.ts`, or whether the project should exclude `.agents/**` from `staged`, is not decided.
- **Projects scaffolded with `--no-hooks`.** Such a project has no `.vite-hooks/pre-commit` and no dispatcher. These steps were not tested there.
