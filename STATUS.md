# STATUS

Updated: 2026-10-31

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Checkpoint 0 passed: Schalk confirmed it on 2026-10-22 on the recorded evidence. The reduced audit worksheet (CAL-001, #448) is complete and approved, every removal has an issue (#452 to #456, all merged), and the CQ1 and CQ2 ADRs are accepted (ADR-0009 merged in #530 on 2026-09-28; ADR-0001).

The Increment 1 exit condition (H0) is not met. ADR-0015 is merged, and its first slice, the `skill-protected-branch-guard` artifact (#745), is three of four stacked pull requests in. The bootstrap readiness check (#749) has not been run as a recorded exercise.

## Completed this session

- Opened #785, a decision issue on installing every bundled skill behind a router skill instead of selecting skills per recipe.
- Opened #797 and PR #798: the Fledgling mint commands, the root Fledgling config, its release contract, the runbook, and the release-with-confidence skill use `--publish` and `"publish": true` instead of the deprecated `permissions` option.
- #745, layer 1 (PR #796, draft): skill manifests declare `inputs` and `wiring`, recipes record input values, and `packages/cli/src/ai/artifact-inputs.js` resolves and checks them. A branch name is limited to `[A-Za-z0-9._/-]`, because it is written into hook commands that a shell runs.
- #745, layer 2 (PR #799, draft): `planViteHookBlock` plans Calavera's marked block in a `.vite-hooks` script and stops on an edited block, a broken or changed marker, and a block it has no record of writing.
- #745, layer 3 (PR #800, draft): `planClaudeSettings` plans an artifact's hook groups in `.claude/settings.json`, and `formatJSON` writes JSON the way Oxfmt formats it, at Oxfmt's default width of 100 and in display columns. A rewrite that would lose a value elsewhere in the file is a conflict, and a layout-only rewrite is reported for the dry run.
- Confirmed against the installed Claude Code 2.1.310 build that `Write`, `Edit`, and `MultiEdit` carry their path in `tool_input.file_path` and `NotebookEdit` in `tool_input.notebook_path`, which ADR-0015, Decision 7, left open.

## In progress

- #745, layer 4, not started. It holds the guard package and its scripts, the apply, init, and `compose_recipe` wiring, and the docs. The scripts and their 26 tests are written and saved as `.git/calavera-745/scripts-layer.patch` (untracked, local to this clone) and in the Git stash "745 guard scripts". They were set aside when the layers changed order.
- `@schalkneethling/calavera-skill-protected-branch-guard` is not minted. The Fledgling dry run was clean; the apply needs Schalk's npm login and 2FA: `pnpm exec fledgling add @schalkneethling/calavera-skill-protected-branch-guard --new --yes --repo schalkneethling/create-project-calavera --workflow publish.yml --env publish --publish --placeholder-version 0.0.0`.
- #722 (Version Packages) is open.

## Blocked

- #671 (remove the exit 127 known-issue section) waits on #689. Vite+ closed voidzero-dev/vite-plus#2970 without a change, so no Vite+ release will fix it.
- #737 waits on a Stryker release that fixes stryker-mutator/stryker-js#6111.
- #746 (`skill-red-test-verification`) waits on the adoption trigger that ADR-0015 records in #744.

## Handoffs

- H0: pending (Increment 1 exit condition)
- H1: pending
- H3: pending
- H6: pending
- H7: pending
- Consumed: H2 pending | H4 names pending | H5 pending

## Audit

- Entries classified: 13 of 37 (fourteen worksheet rows; 24 entries deferred in #449). Removals opened: 5 (#452 to #456). Merged: 5. Awaiting approval: 0.

## Open cross-repo requests

- none

## Decisions taken this session (with ADR link)

- The `inputs` and `wiring` schema in PR #796 is the final shape. Decided by Schalk on 2026-10-31 (ADR-0015, Decision 4 left the names to #745).
- `apply_recipe` refuses a declared input the recipe does not record; `dry_run_apply` returns the recipe with the value filled in. This is stricter than ADR-0015, Decision 6, and layer 4 amends the ADR. Decided by Schalk on 2026-10-31.
- On a project without Vite+ hooks, apply warns, saying the guard hooks will not run and naming the command that installs the Vite+ hook dispatcher. Decided by Schalk on 2026-10-31 (an open question in ADR-0015).
- ADR-0015's status line changes to "Accepted" in layer 4. Decided by Schalk on 2026-10-31.
- The #745 stack is four layers, with the two writers before the guard package, because a catalog row would make the guard selectable before apply writes its hooks. Decided by Schalk on 2026-10-31.

## Next session starts with

- Review PRs #796, #799, and #800, and PR #798.
- #745, layer 4: apply the saved scripts patch into `packages/artifacts/skill-protected-branch-guard/`, add the package, manifest, and catalog row, connect both planners and the input resolver to apply, the dry run, the state record, init, and `compose_recipe` (the saved wiring diffs are in `.git/calavera-745/`), add the `--no-hooks` warning, update `docs/ai-adapter-guidance.md`, the README count, and ADR-0015, scan the payload with SkillSpector, and end the description with "fix #745".
- Mint the guard package before layer 4's release.
- #669 can adopt `formatJSON` once PR #800 merges.
- Finish Increment 1: the Determinant tracking issue (#744), the readiness check (#749), then H0 (#750).
