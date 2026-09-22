# STATUS

Updated: 2026-09-22

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Last checkpoint passed: none. Checkpoint 0 is in progress: the CQ2 ADR is accepted and the reduced audit worksheet (CAL-001, #448) is complete and approved, but the CQ1 ADR (CAL-003) is outstanding. CQ1 is resolved in the sequencing map text (Calavera provides no JS or TS toolchain to any project) and no ADR file records it yet; the brief's Checkpoint 0 names that ADR as a criterion.

The removal stack (CAL-012 to CAL-016), the Baseline data work (#473, #477), pull request CI (#474), the repository linting fold (#484), and the Baseline refresh workflow (#497) are all on `main`; the refresh workflow has run green twice, and #490 is closed. The Version Packages pull request (#494) for the 3.0.0 release is open.

## Completed this session

- Maintenance outside Increment 1 (#507, branch `remove-release-minting-507`, pull request open): Dependabot's fledgling bump (#504) failed `Check` on a version literal in `scripts/check-release-contracts.mjs`. The literal served the release orchestrator's automated bootstrap path, which ran Fledgling and then a draft-publish-verify ceremony that no test could exercise because minting a name on npm is irreversible. `pnpm release:prepare` now plans the registry first and, before any gate, fails with the exact `pnpm exec fledgling add` dry-run and apply commands when a package name does not exist on npm; the operator mints by hand and reruns. A prerelease as the first real version of a minted package is refused. Trusted-publisher verification runs in prepare for each package the release will publish, so every release now needs npm 11.15.0+ logged in with 2FA. `--bootstrap` and the bootstrap ceremony are removed; unknown orchestrator flags are rejected. The contract check asserts only that the fledgling pin is exact. ADR-0008 records the decision; patch Changeset for the release-with-confidence skill. Red tests, removal, and docs landed as separate commits. `pnpm check` exits 0.

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

- Package minting removed from the release orchestrator: `docs/adr/0008-remove-package-minting-from-release-orchestrator.md` (Accepted 2026-09-22). Whether a Fledgling major bump deserves its own hard gate is left open.

## Next session starts with

- Review and merge the #507 pull request. Then rebase Dependabot #504 (`@dependabot rebase`), confirm `Check` passes on the exact-pin assertion, and merge it. #502, #503, #505, and #506 are unaffected by #507.
- Merge #494 (Version Packages) for the 3.0.0 release, then CAL-011 (profiles collapse on a `vp` project). React Doctor follow-up: re-express its two scripts as `vp run` tasks.
- Make the `Check` status required on `main` and shrink the validation guidance in PR.md to "CI must be green".
- Write the CQ1 ADR (CAL-003) so Checkpoint 0 can pass.
- The five follow-up issues named in ADR-0001 are open: #429 to #433. The unparseable-manifest MCP-level test waits on #429.
