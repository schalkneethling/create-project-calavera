# STATUS

Updated: 2026-09-28

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Last checkpoint passed: none. Checkpoint 0 is in progress: the CQ2 ADR is accepted and the reduced audit worksheet (CAL-001, #448) is complete and approved, but the CQ1 ADR (CAL-003) is outstanding. CQ1 is resolved in the sequencing map text (Calavera provides no JS or TS toolchain to any project) and no ADR file records it yet; the brief's Checkpoint 0 names that ADR as a criterion.

The removal stack (CAL-012 to CAL-016) shipped as create-project-calavera 3.0.0 on 2026-09-24. The Baseline data work, pull request CI, the repository linting fold, and the Baseline refresh workflow are all on `main`. Both release-day pull requests and every follow-up are merged; no release-related pull request remains open. The stack toward the release that starts a project with `--new` is open: #530 (CQ1 ADR-0009, CAL-003), #531 (ADR-0010, `--new` delegates to `vp create`), and #535 (CAL-011, profiles collapse), with #535 to merge last before the Version Packages release because Composer has no profile version gate (#533).

## Completed this session

- Release v3.0.0 and the artifact patch release `packages-00349b3337f9` shipped on 2026-09-24. The major carries the CAL-012 to CAL-016 removals held since Version Packages #460; every public package's `latest` matches `main`.
- Minting removed from the release orchestrator (#507, PR #508, merged): Dependabot's fledgling bump (#504) failed `Check` on a version literal in `scripts/check-release-contracts.mjs` that served an untestable bootstrap ceremony. `pnpm release:prepare` now fails before any gate with the exact `pnpm exec fledgling add` dry-run and apply commands when a package name does not exist on npm; the operator mints by hand and reruns. `--bootstrap` and the ceremony are gone; unknown orchestrator flags are rejected; the contract check parses the fledgling pin with `semver.valid` and requires it exact. ADR-0008.
- Trusted-publisher check removed from prepare (#509, PR #510, merged): the first release after #508 failed on `npm trust list`, which npm cannot answer with a one-time password when stdout is piped. OIDC publish already fails on a missing trusted publisher and `verifyPublishedPackages` checks provenance. ADR-0008 amended with the evidence; runbook says npm login is needed only to mint.
- Artifact compatibility cap dropped (#513, PR #514, merged): every artifact declared `>=2.2.0 <3`, so the 3.0.0 CLI rejected all sixteen at install time and the hosted Composer hid them. The range is a lower bound only, which is what Composer uses to withhold an artifact until a CLI that can install it is published; `schemaVersion` carries manifest contract changes. New drift test `packages/artifact-core/test/compatibility.test.mjs` fails when any range excludes the workspace CLI version. Patched artifacts and artifact-core 0.4.1 shipped in the second release. Verified by installing two published artifacts with the published 3.0.0 CLI into a scratch project.
- Release defects found on the day, all fixed and merged: #512 (PR #517: a rerun during npm propagation derived a different tag and created a second release for the same commit; `publishRelease` now resolves the published release for the candidate commit before deriving a tag, refuses when two exist, and watches the workflow run to completion on both paths; the stray release was deleted by hand), #511 (PR #518: the retry loop prints one line per wait), #523 (PR #524: a re-run publish workflow's `Skipping already published` lines count as confirmation for the provenance and publish-line checks, npm checks still run, and the contract check pins that text to `publish.yml`; publish and skip lines match only at a log line end).
- Pre-release integration test (#515, PR #526, merged): `release:fixture` now runs `packages/cli/scripts/release-integration.test.mjs`, which packs every workspace artifact with `pnpm pack` and installs it through the real `artifacts install` path and the real extractor with the workspace CLI version, one per fixture and all together, comparing every installed output with its package-store payload. Breaking one manifest's range locally reproduced the release-day failure. The Composer half is not faked: `apps/composer/script.js` touches the DOM at import, so #525 proposes the DOM-free `recipe-builder.js` seam.
- Vite+ dogfooding check (2026-09-27, evidence gathered read-only): detection is done and tested (`detectVitePlus`, ADR-0001, `inspect_project` reports `vitePlus`), but no downstream path reads it: `compose_recipe`, `validate_recipe`, `dry_run_apply`, `apply_recipe`, profile selection, and `doctor` never consult `vitePlus.status`. `modern` and `classic` profile defaults are already identical arrays in `packages/cli/src/recipe.js` with the collapse deferred to CAL-011, which has no issue yet. No real `vp create` fixture exists (the detection tests build hand-written manifests; #433 is open), nothing spawns `vp` (#442 undecided), no test runs the agent-first flow end to end on a vp-managed directory, `docs/vite-plus.md` (CAL-019) is unwritten, and H0 is pending. "Works on a vp project" holds today only because the overlapping tooling was removed.

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

- Review #530, #531, and #535; accept ADR-0009, ADR-0010, and ADR-0011 at review. Merge #535 last, immediately before the Version Packages release.
- Implement `--new` (#532) once ADR-0010 is accepted, then the dogfood run from a packed build in an empty directory. React Doctor follow-up: re-express its two scripts as `vp run` tasks.
- Then #433 with a real `vp create` fixture and an end-to-end test of `inspect_project`, `compose_recipe`, `dry_run_apply`, `apply_recipe` against it; that is the evidence H0 needs.
- Make the `Check` status required on `main` and shrink the validation guidance in PR.md to "CI must be green".
- #525 (Composer recipe seam) when Composer is next touched. The other follow-up issues named in ADR-0001 are open: #429 to #432. The unparseable-manifest MCP-level test waits on #429.
