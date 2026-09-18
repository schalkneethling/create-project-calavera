# STATUS

Updated: 2026-09-18

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Last checkpoint passed: none. Checkpoint 0 is in progress: the CQ2 ADR is accepted and the reduced audit worksheet (CAL-001, #448) is complete and approved, but the CQ1 ADR (CAL-003) is outstanding. CQ1 is resolved in the sequencing map text (Calavera provides no JS or TS toolchain to any project) and no ADR file records it yet; the brief's Checkpoint 0 names that ADR as a criterion.

The removal stack (CAL-012 to CAL-016), the Baseline data work (#473, #477), pull request CI (#474), and the repository linting fold (#484) are all on `main`. The Version Packages pull request (#494) for the 3.0.0 release is open.

## Completed this session

- Maintenance outside Increment 1 (#497, branch `baseline-refresh-workflow-497`, pull request open): Dependabot bumped `baseline-browser-mapping` or `web-features` and left the generated Baseline data behind twice in three days (web-features 3.38.0, fixed in #473; baseline-browser-mapping 2.11.24, still failing `Check` in #490), each time needing the same correction by hand. That correction is now a workflow. `.github/dependabot.yml` ignores both packages in the npm ecosystem, and `.github/workflows/baseline-data-refresh.yml` ("Refresh Baseline data", weekly on Tuesday plus `workflow_dispatch`) bumps them with `pnpm update`, which keeps the exact pins and respects `minimumReleaseAge`, then runs `build-data.mjs --check` and acts on what it reports: nothing when the data is current, `--changeset --cutoff <today>` when the cutoff is stale, `--changeset` alone when only the versions moved, so a weekly run never advances the cutoff for its own sake. One pull request from the fixed branch `baseline-data-refresh`, opened by `peter-evans/create-pull-request` with `GITHUB_TOKEN`, carries the bump, the regenerated data, the snapshot cutoff, and the Changeset together. Known limitation: a pull request opened with `GITHUB_TOKEN` does not start `pull_request` workflows, so `Check` does not run until somebody closes and reopens the refresh pull request. The refresh pull request body says so. The alternative workarounds (a fine-grained personal access token or a GitHub App token) need a secret this session did not create. No tests: the wiring is verified by hand at change time. `pnpm workflow:check` (zizmor 1.25.2, offline) reports no findings, and `pnpm exec oxfmt --check` accepts both files.

## In progress

- none

## Blocked

- none

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

- No ADR. #497 records the trade-off it accepts: the two Baseline data sources leave Dependabot's cooldown and grouping and follow the refresh workflow's weekly cadence instead, with `minimumReleaseAge` in `pnpm-workspace.yaml` still governing what pnpm selects.

## Next session starts with

- Review and merge #497, then trigger `Refresh Baseline data` once with `workflow_dispatch` and close #490 when the refresh pull request supersedes it. Confirm on that run that Dependabot opens nothing further for `baseline-browser-mapping` or `web-features`, and that `Check` reaches the refresh pull request after a close and reopen.
- Merge #494 (Version Packages) for the 3.0.0 release, then CAL-011 (profiles collapse on a `vp` project). React Doctor follow-up: re-express its two scripts as `vp run` tasks.
- Make the `Check` status required on `main` and shrink the validation guidance in PR.md to "CI must be green".
- Write the CQ1 ADR (CAL-003) so Checkpoint 0 can pass.
- The five follow-up issues named in ADR-0001 are open: #429 to #433. The unparseable-manifest MCP-level test waits on #429.
