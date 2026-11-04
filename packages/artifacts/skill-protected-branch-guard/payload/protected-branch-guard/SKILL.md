---
name: protected-branch-guard
description: Start new work on a feature branch created from the protected branch, and respond correctly when the protected branch guard refuses a commit, a push, or a file edit. Use when asked to start work, create a work branch, or begin a change in a repository that has the protected branch guard, or when a commit, push, or edit fails with "Protected branch guard".
---

# Protected branch guard

This repository refuses commits, pushes, and agent file edits on one protected branch, usually `main` or `master`. The guard runs from Git hooks and from agent hooks, so it applies whether or not you use this skill. Use this skill to start work the way the guard expects, and to understand a refusal instead of working around it.

## Find the protected branch

The protected branch is the last argument of each guard line in `.vite-hooks/pre-commit`, for example `node .agents/skills/protected-branch-guard/scripts/guard.mjs commit main`. Calavera also records it in `calavera.config.json`, as `inputs.protectedBranch` on the `skill-protected-branch-guard` entry of the `ai` list.

## Start work

Only start work after the user has asked to begin work or create a branch. Read-only discovery and review need no branch.

1. Choose a slug: lowercase words joined by hyphens, such as `745-protected-branch-guard`. If the user gave one, use it unchanged. If the repository asks for an issue number in branch names, start the slug with it.
2. From the repository, run:

   ```sh
   node .agents/skills/protected-branch-guard/scripts/start-work.mjs <slug> --base <protected-branch>
   ```

   The slug becomes the branch name. The script creates the branch from the local protected branch and switches to it. It does not fetch, pull, commit, or push.

3. Add `--worktree <path>` when the user asks for a separate checkout. Report the absolute path and do the rest of the work there, because creating a worktree does not move your working directory.
4. Report the branch and the directory the script printed.

Pass the slug as one argument, never as shell code. When the script refuses, stop and explain why to the user:

- **The working tree is dirty.** Existing changes must be preserved. Ask the user how to move them. Do not stash, reset, or commit them.
- **The local and cached remote protected branch differ.** Updating the protected branch is a separate step that the user must authorize.
- **The branch already exists, or a name is invalid.** Ask the user for another slug.

## When the guard refuses

A refusal starts with `Protected branch guard:`.

- **"<branch> is read-only"** means the commit, push, or edit targets the protected branch or a detached HEAD. Start work on a feature branch as described above, then repeat the change there.
- **"Push to <branch> refused"** means a push would update, force-update, or delete the protected branch. Push the feature branch and open a pull request instead.
- **"The protected branch argument is wrong"** means a hook line is missing the branch name or holds an invalid one. The message names the file and shows the correct line. Tell the user, because the line is project configuration.

Never bypass the guard to finish a task. Do not use `--no-verify`, set `HUSKY=0`, `VP_GIT_HOOKS=0`, or `VITE_GIT_HOOKS=0`, run `vp hooks disable`, or edit the guard lines unless the user explicitly asks you to.

## Codex

Calavera writes the Git hook lines and the Claude Code hooks. It does not write Codex hooks. To add the guard to Codex, merge the `SessionStart` and `PreToolUse` groups of `hooks/hooks.codex.json` into `.codex/hooks.json`, replace every `{{protectedBranch}}` with the protected branch, and trust the hooks in Codex with `/hooks`. An unreplaced `{{protectedBranch}}` makes every guarded edit fail with an error that names `.codex/hooks.json`.

## Limits

- `git push --no-verify` skips the pre-push hook. Protect the branch on the Git host as well, for example with a GitHub ruleset.
- Git runs the hooks through the Vite+ dispatcher, which `vp config` installs. A clone or linked worktree where `vp config` has not run, or where `vp hooks disable` ran, has no dispatcher, so Git does not run the guard there.
- During a rebase, the guard judges the branch being rebased. It still refuses a rebase of the protected branch and a commit on any other detached HEAD.
- The session notice runs `git status` with a 5-second limit. In a very large repository it can report a Git error instead of the branch state. The notice is advisory and blocks nothing.
