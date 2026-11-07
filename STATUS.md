# STATUS

Updated: 2026-11-07

## Current phase and checkpoint

Increment 1 (sequencing map Section 0) is complete. Handoff H0 is delivered: `create-project-calavera` 6.1.0, verified on a fresh `vp create vite:monorepo` project on 2026-11-07. The evidence is [`docs/bootstrap-readiness-record.md`](docs/bootstrap-readiness-record.md), merged in PR #847, which closed #749.

Checkpoint 0 passed: Schalk confirmed it on 2026-10-22 on the recorded evidence. Checkpoint 1 has not been reviewed, and this file does not propose that it passed. Its four criteria are in `docs/evolution-brief.md`. Only the first has an evidence source today:

1. On a fresh `vp create` project, `compose_recipe` offers no JS or TS toolchain integrations. The readiness record is the evidence source.
2. On a non-`vp` project, the CQ1 outcome is what is offered. No evidence source yet.
3. No removed entry is reachable through the CLI, MCP, or Composer. No evidence source yet.
4. The existing safety-property tests pass unchanged. No evidence source yet.

Section 0 of the sequencing map is now a skeleton for the next increment. The owner reviews it and decides what the next increment contains. No work from the next increment has started.

## Completed this session

- Releases: v6.0.0 (2026-11-04) and v6.1.0 (2026-11-06).
- #745 (the `skill-protected-branch-guard` artifact) closed with PR #803, merged on 2026-11-04. The guard package is published as 0.1.0 (`npm view` returns it).
- #748 (flow test for guard wiring, Knip ignore, MCP registration, and EditorConfig) closed with PR #828.
- #669 (generated files fail `vp fmt --check` in Vite+ projects) closed with PR #831, which formats generated JSON and Markdown with the project's `vp fmt`. It shipped in 6.1.0.
- #802 (remove a deselected artifact's wiring, and report wiring in `doctor`) closed with PR #832.
- #824 (replace the code-review skill with the verified-findings review skill) closed with PR #825.
- #814 and #816 (ignore `.claude/worktrees/` in `.gitignore` and in the generated Stylelint and HTML Validate configuration) closed with PRs #815 and #817. #677 was closed on 2026-11-07 as resolved by #815.
- #749 (the bootstrap readiness check) closed with PR #847. It ran the published 6.1.0 and produced the friction issues below.

### Filed by the readiness check

- #838: the Vite+ pre-commit hook reformats `.calavera/state.json` after every apply.
- #839: the README and `--help` list 9 of the 14 MCP tools the server exposes.
- #840: the agent prompt that `--init` prints differs from the README prompt.
- #841: apply leaves `.calavera/cache/npm` in the project without saying whether to commit it.
- #842: Calavera does not warn when the project has no Git repository, so hooks and the guard never run.
- #843 (p1): the generated `knip.json` reports Calavera's extracted artifact packages, so `pnpm quality` fails after apply.
- #844: `github-repository-controls` defaults `defaultBranch` to `main` even when the project's branch is `master`.
- #846: a decision issue about the default `protectedBranch` for the guard, because the current branch is a feature branch in the documented flow.
- Comments on #675 (the next steps that a pinned launch prints use an unpinned runner), #643 (a new `restrict-template-expressions` warning in the generated `scripts/repository-controls.mjs`), and #617 (the dry run after a complete apply still prints the install command, and lists `skill-calavera` as downloaded).
- Upstream report voidzero-dev/vite-plus#3381: the `vite:monorepo` template declares catalog entries that no workspace package uses.

## In progress

- The private scratch repository `schalkneethling/calavera-h0-scratch` is not deleted yet, because `gh` lacks the `delete_repo` scope. The owner deletes it, or grants the scope and asks for the deletion.
- The branch `750-h0-handoff` holds the H0 handoff documents (#750). No pull request is open, because the owner reviews the Section 0 skeleton first.

## Blocked

- #671 (remove the exit 127 known-issue section) waits on #689. Vite+ closed voidzero-dev/vite-plus#2970 without a change, so no Vite+ release will fix it.
- #737 waits on a Stryker release that fixes stryker-mutator/stryker-js#6111.
- #746 (`skill-red-test-verification`) waits on the adoption trigger that ADR-0015 records in #744.

## Handoffs

- H0: delivered 6.1.0 2026-11-07 ([readiness record](docs/bootstrap-readiness-record.md))
- H1: pending
- H3: pending
- H6: pending
- H7: pending
- Consumed: H2 pending | H4 names pending | H5 pending

## Audit

- Rows classified: 16 of 37 in `docs/catalog-audit.md`; the other 21 are deferred in #449. Removals opened: 5 (#452 to #456). Merged: 5. Awaiting approval: 0.

## Open cross-repo requests

- none

## Decisions taken this session (with ADR link)

- `clean` is intentional: it removes an artifact's wiring when that wiring is untouched, under the same rules as apply. Decided by Schalk on 2026-11-07 (recorded on #829).
- #749 ran on Opus 5.5 at high effort, not Fable. Decided by Schalk on 2026-11-07.
- The next release also includes these fixes outside Increment 1: #829, #795 (item 1), #830, #792, #790, #784, and #837. Approved by Schalk on 2026-11-07.

## Next session starts with

- Review the Section 0 skeleton in `docs/cross-repo/sequencing-map.md` and decide what the next increment contains. Nothing from the next increment starts before then.
- Decide #846 (the guard's `protectedBranch` default). Triage the friction issues listed above; #843 is the only p1, because it makes `pnpm quality` fail after apply.
- Deferred decisions: #673 (should the `--init` bootstrap install the Calavera skill when the recipe leaves it out) and #676 (should `--new` choose its runner from the launching package manager).
- #669 is delivered in 6.1.0 (PR #831), so it is not pending.
- Delete the scratch repository `schalkneethling/calavera-h0-scratch` once `gh` has the `delete_repo` scope.
- The saved patches in the shared Git folder (`calavera-745/`) and the Git stash "745 guard scripts" were applied in PR #803, which has merged. They can be deleted after the owner approves the list of what would go.
