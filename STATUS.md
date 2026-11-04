# STATUS

Updated: 2026-10-31

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Checkpoint 0 passed: Schalk confirmed it on 2026-10-22 on the recorded evidence. The reduced audit worksheet (CAL-001, #448) is complete and approved, every removal has an issue (#452 to #456, all merged), and the CQ1 and CQ2 ADRs are accepted (ADR-0009 merged in #530 on 2026-09-28; ADR-0001).

The Increment 1 exit condition (H0) is not met. ADR-0015 is accepted, and its first slice, the `skill-protected-branch-guard` artifact (#745), has its last layer in review as PR #803. The bootstrap readiness check (#749) has not been run as a recorded exercise.

## Completed this session

- #797 and PR #798 (merged): the Fledgling mint commands, root config, release contract, runbook, and release-with-confidence skill use `--publish` and `"publish": true`.
- #745, layers 1 to 3 (PRs #796, #799, #800, merged): skill manifests declare `inputs` and `wiring`, recipes record input values, `planViteHookBlock` plans Calavera's marked block in a `.vite-hooks` script, and `planClaudeSettings` plans an artifact's hook groups in `.claude/settings.json`.
- PR #800 replaced the hand-written Oxfmt imitation with `loadProjectFormatter` (`packages/cli/src/utils/project-formatter.js`). A rewritten JSON file is formatted in memory, before the dry run, by the project's own `vp fmt --stdin-filepath`, which applies the project's Oxfmt version, `fmt` settings, `.editorconfig`, and ignore patterns and writes nothing. Each run has a 60-second limit. A project Vite+ does not manage gets `JSON.stringify` output.
- #745, layer 4 (PR #803, open): the guard package, the catalog row, and apply wiring (`packages/cli/src/ai/artifact-wiring.js`). Apply plans every artifact's wiring before it writes anything, records it as `aiWiring` in the state, refuses an unrecorded input outside a dry run, and warns with the fitting remedy when Git would not run the hooks. ADR-0015 is accepted and amended. Two adversarial reviews ran; their disposition is in the PR.
- Opened #802: remove an artifact's wiring when it is deselected, and report wiring in `doctor`.
- Confirmed against Claude Code 2.1.310 that `Write`, `Edit`, and `MultiEdit` carry their path in `tool_input.file_path` and `NotebookEdit` in `tool_input.notebook_path` (recorded in ADR-0015, Decision 7).

## In progress

- PR #803 (#745, layer 4) waits for review and CI. Merging it closes #745.
- `@schalkneethling/calavera-skill-protected-branch-guard` is not minted; `npm view` returns 404. The apply needs Schalk's npm login and 2FA: `pnpm exec fledgling add @schalkneethling/calavera-skill-protected-branch-guard --new --yes --repo schalkneethling/create-project-calavera --workflow publish.yml --env publish --publish --placeholder-version 0.0.0`. It must be minted before the release that ships PR #803.
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

- The `inputs` and `wiring` schema of PR #796 is the final shape. Decided by Schalk on 2026-10-31 (ADR-0015, Decision 16).
- `apply_recipe` refuses a declared input the recipe does not record; `dry_run_apply` returns the recipe with the value filled in. Decided by Schalk on 2026-10-31 (ADR-0015, Decision 6, amended). PR #803 applies the same rule to any non-interactive apply, because the reason is the same.
- When Git would not run the guard's hooks, apply warns with the command that fixes it and does not stop. Decided by Schalk on 2026-10-31 (ADR-0015, Decision 16).
- ADR-0015 is accepted. Decided by Schalk on 2026-10-31.
- A rewritten JSON file is formatted in memory with the project's own `vp fmt` before the dry run, and nothing is formatted after it is written. Decided by Schalk on 2026-10-31 (ADR-0015, Decision 5, amended).
- When the project's `vite-plus` cannot be loaded: a Vite+ project stops with the `vp install` remedy, and any other project gets unformatted output. Decided by Schalk on 2026-10-31.
- `skill-protected-branch-guard` declares compatibility `>=5.0.1`, the workspace CLI version, because published 5.0.1 refuses the unknown ID. Decided by Schalk on 2026-10-31.

## Next session starts with

- Review and merge PR #803, which closes #745.
- Mint the guard package before the release that ships it.
- #669 in its own PR: write the seven files it lists through `loadProjectFormatter`, fix the list in the repository-controls docs template, and add the `vp fmt --check` fixture test.
- Decide #802 (remove or report the wiring of a deselected artifact).
- Finish Increment 1: the Determinant tracking issue (#744), the readiness check (#749), then H0 (#750).
- The saved patches in `.git/calavera-745/` and the Git stash "745 guard scripts" are applied in PR #803 and can be deleted once it merges.
