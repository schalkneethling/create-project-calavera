# STATUS

Updated: 2026-09-24

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Last checkpoint passed: none. Checkpoint 0 is in progress: the CQ2 ADR is accepted and the reduced audit worksheet (CAL-001, #448) is complete and approved, but the CQ1 ADR (CAL-003) is outstanding. CQ1 is resolved in the sequencing map text (Calavera provides no JS or TS toolchain to any project) and no ADR file records it yet; the brief's Checkpoint 0 names that ADR as a criterion.

The removal stack (CAL-012 to CAL-016) shipped as create-project-calavera 3.0.0 on 2026-09-24. The Baseline data work, pull request CI, the repository linting fold, and the Baseline refresh workflow are all on `main`. The Version Packages pull request (#494) for the 3.0.0 release is open.

## Completed this session

- Release v3.0.0 and the artifact patch release `packages-00349b3337f9` shipped on 2026-09-24. The major carries the CAL-012 to CAL-016 removals held since Version Packages #460; every public package's `latest` matches `main`.
- Minting removed from the release orchestrator (#507, PR #508, merged): Dependabot's fledgling bump (#504) failed `Check` on a version literal in `scripts/check-release-contracts.mjs` that served an untestable bootstrap ceremony. `pnpm release:prepare` now fails before any gate with the exact `pnpm exec fledgling add` dry-run and apply commands when a package name does not exist on npm; the operator mints by hand and reruns. `--bootstrap` and the ceremony are gone; unknown orchestrator flags are rejected; the contract check parses the fledgling pin with `semver.valid` and requires it exact. ADR-0008.
- Trusted-publisher check removed from prepare (#509, PR #510, merged): the first release after #508 failed on `npm trust list`, which npm cannot answer with a one-time password when stdout is piped. OIDC publish already fails on a missing trusted publisher and `verifyPublishedPackages` checks provenance. ADR-0008 amended with the evidence; runbook says npm login is needed only to mint.
- Artifact compatibility cap dropped (#513, PR #514, merged): every artifact declared `>=2.2.0 <3`, so the 3.0.0 CLI rejected all sixteen at install time and the hosted Composer hid them. The range is a lower bound only, which is what Composer uses to withhold an artifact until a CLI that can install it is published; `schemaVersion` carries manifest contract changes. New drift test `packages/artifact-core/test/compatibility.test.mjs` fails when any range excludes the workspace CLI version. Patched artifacts and artifact-core 0.4.1 shipped in the second release. Verified by installing two published artifacts with the published 3.0.0 CLI into a scratch project.
- Release defects found on the day, fixed in open pull requests: #512 (PR #517: a rerun during propagation derived a different tag and created a second release for the same commit; the orchestrator now resolves the published release for the commit first; the stray release was deleted by hand) and #511 (PR #518: the retry loop now reports each wait). #515 records the missing pre-release integration coverage of the critical CLI, artifact, and Composer workflows and needs the owner's scoping.

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

- Package minting removed from the release orchestrator: `docs/adr/0008-remove-package-minting-from-release-orchestrator.md` (Accepted 2026-09-22, amended 2026-09-24 to remove the trusted-publisher check). Whether a Fledgling major bump deserves its own hard gate is left open.
- Artifact compatibility ranges carry a lower bound only. No ADR; the reasoning is recorded in `docs/architecture/versioned-artifacts.md` and the Changeset for #514. Whether `skill-calavera` should raise its lower bound to `>=3.0.0` is left open in #513.

## Next session starts with

- Review and merge #517 (#512) and #518 (#511) so the next release is safe to rerun unattended.
- Scope #515 (pre-release integration tests): pick the critical workflows; the proposal is to pack the workspace CLI and artifacts and install each from its tarball through the real `artifacts install` path in `release:rehearse`, and to run a Composer-built recipe through `validateRecipe` and `dry_run_apply`.
- Make the `Check` status required on `main` and shrink the validation guidance in PR.md to "CI must be green".
- Write the CQ1 ADR (CAL-003) so Checkpoint 0 can pass, then CAL-011 (profiles collapse on a `vp` project). React Doctor follow-up: re-express its two scripts as `vp run` tasks.
- The five follow-up issues named in ADR-0001 are open: #429 to #433. The unparseable-manifest MCP-level test waits on #429.
