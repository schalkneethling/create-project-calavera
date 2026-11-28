Calavera is what runs after `vp create`: Baseline target, CSS verification (css-evolve), HTML and accessibility checks, Playwright, agent artifacts, release trust. Vite+ owns the JS and TS toolchain; Calavera never competes with it.

## Repository rules

- For pull request guidance, please see PR.md
- _Always_ ensure that we have the latest changes from the remote repository.
- _Always_ ensure that no feature work is started from main. Always use a feature branch.
- When creating the feature branch, always include the GitHub issue number in the branch name.
- When writing the pull request description, always include fix #<issue_number> at the end of the description. If the pull request fixes multiple issues, include all of them.
- Do _not_ write types for the sake of types in TypeScript. Only define types when TypeScript cannot cleanly infer from usage.
- Match validation and test tooling to the kind of confidence needed:
  - Use tests for repository invariants, contract checks, and drift checks.
  - Use a JSON Schema validator such as Ajv when validating JSON Schema behavior or arbitrary JSON data against a published schema.
  - Consider Valibot, Zod, or similar libraries when a typed authoring schema should become the source of truth, especially if JSON Schema will be generated from it.

## Session start (read, do not import)

1. Where the last session stopped: `gh pr list`, `git status`, `git worktree list`, and `git stash list`. The tracker and the files below are the record; there is no separate status file.
2. The current release's kickoff issue: `gh issue list --label release-kickoff`. Work only that release; anything else you notice becomes a backlog issue (see Releases). If no kickoff issue is open, or more than one is, ask the owner which release is current before starting release work. `docs/cross-repo/sequencing-map.md` holds the handoff timeline with css-evolve.
3. `docs/cross-repo/requests/` — open requests and responses.
4. `docs/evolution-brief.md` — decisions, spikes, phases, checkpoints. Consult when a decision's rationale or an issue's acceptance criteria are needed.
5. `docs/cross-repo/interface-contract.md` — before touching any surface shared with css-evolve.

## Rules in force every turn

- Guidance is a cost paid on every turn; a check is paid once. Whenever a rule in this file, in a skill, or in a brief could instead be a test, a lint rule, an ast-grep pattern, or a Determinant gate, or whenever the same correction has been needed twice, raise it: open an issue (label `guidance-to-check`) that names the rule, the proposed check, and the trade-offs, and stop there. Do not implement the check or remove the guidance until the project owner decides whether it becomes deterministic or stays as guidance.
- Litmus test: anywhere Calavera fights with or reimplements something Vite or Vite+ does well, Calavera steps aside and that part is removed. Removals are complete: no deprecated paths, flags, or legacy modes. Each removal is one PR with an ADR; do not batch removals.
- Safety invariants (brief C8) are guarded by tests that are never weakened: only the CLI writes into projects; `dry_run_apply` is the approval boundary; local edits are preserved; artifacts are not written to `package.json`; conflicts surface as hard stop or migration decision. Never modify these tests to make a change pass; if a change cannot pass them, stop and write the decision issue.
- Keep failures diagnosable. Concise user-facing errors must preserve underlying causes for debugging. Retain useful structured operational diagnostics, with secrets and sensitive payloads excluded, and test that wrapping and redaction do not make distinct failures indistinguishable.
- Metadata before code: change catalog metadata first; scripts, managed files, diagnostics, guidance only where metadata cannot express the need.
- One issue, one PR, one primary review question named in the description. Test first. `vp` is the command runner.
- Frozen surfaces in the interface contract change only via a cross-repo request and a version bump.
- This repository and css-evolve are worked in separate sessions; never edit the css-evolve repository from here.
- Needs from css-evolve are never worked around: write `docs/cross-repo/requests/YYYY-MM-DD-<slug>.md` from `docs/cross-repo/request-template.md`, comment on the issue that it is blocked and link the request, continue with unblocked work.
- Halt at every `CHECKPOINT` and at the release's exit condition: summarize which criteria pass, which do not, and the exact evidence, then stop. Do not reopen settled decisions in a PR; open a decision issue.
- Prose and docs: MDN style guide, American spelling, no contractions in body prose.

## Releases

- A release starts from one kickoff issue with the `release-kickoff` label and the release's `milestone: <name>` label. Write it in one sitting. It records the goal, the exit condition, the issue list (frozen at kickoff), the expected bump, and the target date, and it settles every decision that would block work before work starts.
- A new finding goes to the backlog, without the current release's `milestone:` label. It joins the release only if the release caused the regression or the finding blocks the exit condition. Breaking removals wait for a release planned to collect them.
- Ownership is shared. Decide what follows from these rules, an ADR, an earlier decision, or consistency, and record why on the issue. Ask the owner only when something is unclear or ambiguous, a matter of taste, outward-facing or hard to undo, or when a second opinion would help.
- When about half of the release's issues are closed, ask the owner to run `pnpm release:rehearse` and `pnpm release:rehearse:cli` in their own terminal, so release-only failures surface before release day. The second command needs the Node.js and Bun versions in `scripts/rehearsal-pins.json` and names any that are missing.
- Before telling the owner to do something, read the code that decides it. Verify a subagent's claim before acting on it.

## Session end

Record decisions on the issue they belong to, and delivered handoffs in the sequencing map. End with a summary for the owner that names anything left only on this machine: unmerged worktrees, stashes, and saved patches.

- Before your session ends, check whether the pull request for your branch has merged with `gh pr view <branch> --json state`. A squash-merged branch does not appear in `git branch --merged`. If it has merged, change to the main worktree, run `git worktree remove <path>`, and delete the local branch with `git branch -D <branch>`. Do not run `git worktree prune`, because it also removes entries for worktrees that other sessions and tools created. If it has not merged, leave the worktree in place and name its path in the summary.
- Never record a path under `/tmp` in a stash message, an issue, or the summary, because `/tmp` can be cleared on restart. Save patches in the shared Git folder instead, which `git rev-parse --git-common-dir` prints. In a linked worktree, `.git` is a file, not a folder.

## Issues and labels

`gh issue create --template cal.md`. Labels: `calavera-evolution`; add `removal`, `handoff`, `dogfood` as applicable. A release's kickoff issue also gets `release-kickoff`.
