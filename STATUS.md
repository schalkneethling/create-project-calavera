# STATUS

Updated: 2026-09-15

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Last checkpoint passed: none. Checkpoint 0 is in progress: the CQ2 ADR is accepted and the reduced audit worksheet (CAL-001, #448) is complete and approved, but the CQ1 ADR (CAL-003) is outstanding. CQ1 is resolved in the sequencing map text (Calavera provides no JS or TS toolchain to any project) and no ADR file records it yet; the brief's Checkpoint 0 names that ADR as a criterion.

## Completed this session

- Maintenance outside Increment 1 (#472, branch `baseline-data-refresh-472`, pull request open): `pnpm release:prepare` failed because Dependabot bumped `baseline-browser-mapping` to 2.11.23 and the regenerated data (#471) left the snapshot cutoff, the hardcoded test pins, and the Changeset behind. `build:data` now derives the latest browser release from `getTimeline()`, prompts for a new non-future cutoff (or takes `--cutoff YYYY-MM-DD`), rewrites `scripts/snapshot.mjs` from a template, regenerates the data, and writes `.changeset/baseline-data-refresh.md` after confirmation (or with `--changeset`); `--check` fails with a distinct stale-cutoff message and never prompts. Tests derive the expected source versions from `package.json`. Data refreshed at cutoff 2026-09-15: widely available floor moved to Firefox 123 and Safari 17.4. Red tests, implementation, and docs landed separately from the regenerated data.
- Pull request CI (#446, branch `pr-ci-446`, pull request open): `.github/workflows/pull-request.yml` runs `pnpm check` (the same gate `publish.yml` runs before a release) on every pull request, on Node 24 with `pnpm install --frozen-lockfile --ignore-scripts` and the Explorer Chromium install, with `contents: read` and per-ref cancel-in-progress concurrency. Passes `pnpm workflow:check`. No Changeset: workflows are not a published package. The first run fails on the `baseline-core` snapshot-cutoff test that #473 fixes, which is the drift this gate exists to catch.
- CAL-012 (#452, PR #459, merged): Oxlint integration and its fourteen plugin pack entries removed; ADR-0002 accepted; Changeset records a major bump for `create-project-calavera` and a patch for the Calavera skill package. Red tests, removal, and docs landed as separate commits. Follow-up #458 (one source for the managed-file list) opened.
- CAL-001 reduced (#448): thirteen in-scope catalog entries (fourteen worksheet rows, because React Doctor is split from the React lint packs) classified with evidence from real `vp` runs on the CAL-002 scratch projects and the Vite+ documentation. Result: eleven `remove` (Oxlint, Oxfmt, TypeScript configuration, ESLint flat config, Prettier, and the five rule packs), two `watch` (Stylelint, trigger H8 and the Oxlint CSS language plugin), one `keep` (React Doctor). Five removal issues proposed, CAL-012 to CAL-016; rule packs fold into their base removals because every pack entry includes its base integration. Deferred rows tracked in #449. Branch `cal-001-448-reduced-audit`.
- CAL-010 (#435): `detectVitePlus` in `packages/cli/src/vite-plus-detection.js`, a pure function over the project directory, with one `node --test` case per ADR-0001 fixture row plus purity and no-ancestor-config tests; `inspect_project` returns the `vitePlus` record and the four finding kinds; docs amended and a minor Changeset added. Red, green, and refactor landed as separate commits on branch `cal-010-435-vp-detection`. Awaiting pull request review.
- CAL-002 (#428): probed vite-plus 0.3.1 with real `vp create vite:library`, `vp create vite:monorepo`, and `vp migrate` runs, surveyed the `inspect_project` surface, and wrote `docs/adr/0001-vite-plus-detection-signal.md`. The ADR chooses the `vite-plus` dependency in the nearest ancestor `package.json` as the single primary signal, matching `vp`'s own self-check, with three corroborating signals recorded for diagnosis only, and specifies the `vitePlus` field and four finding kinds that `inspect_project` reports.

## In progress

- Stacked removal pull requests, merged bottom-up with the Changesets release last: CAL-013 (#453, PR #461, base main), CAL-014 (#454, branch `cal-014-454-remove-typescript-config`, base CAL-013), CAL-015 (#455, PR #468, base CAL-014), CAL-016 (#456, branch `cal-016-456-remove-prettier`, base CAL-015). The stack is complete: after CAL-016 the catalog holds fourteen entries, Modern and Classic have identical defaults, and the availability map holds only React Doctor. Each carries its ADR, docs, Changeset (major), red tests, and removal as separate commits, verified on Node 24.

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

- Entries classified: 13 of 37 (fourteen worksheet rows; 24 entries deferred in #449). Removals opened: 5 (#452 to #456). Merged: 1 (CAL-012). Awaiting approval: 0.

## Open cross-repo requests

- none

## Decisions taken this session (with ADR link)

- Oxlint removal: `docs/adr/0002-remove-oxlint.md` (Accepted 2026-09-14, merged in #459).
- Reduced audit approved: eleven `remove`, two `watch`, one `keep`; ESLint plugin entries found inert (#450), with `eslint-unicorn` and `eslint-sonarjs` approved for removal under CAL-015 alongside the curated pack entries; reintroduction only as metadata edits to the Vite+ lint block (#451). No ADR; ADRs come with each removal PR.
- CQ2 Vite+ detection signal: `docs/adr/0001-vite-plus-detection-signal.md` (Accepted 2026-09-13). Revised after review: the pin location is recorded for pnpm, npm, Yarn, and Bun, and the manifest-less directory case records the ancestor manifest so a later apply flow can offer create-here, apply-at-ancestor, or abandon at the `dry_run_apply` boundary.

## Next session starts with

- Review and merge #472 so `pnpm release:prepare` passes again; the Baseline Explorer needs a separate static deployment for the browser-data change. A local Playwright run needs `pnpm --filter @calavera/baseline-explorer exec playwright install chromium` once. Merge order: #473 first, then #474.
- Review and merge #446 (pull request CI); once it is on `main`, make the `Check` status required on `main` and shrink the validation guidance in PR.md to "CI must be green". Its run goes green only after #473 merges.
- Merge the stack bottom-up (CAL-013, CAL-014, CAL-015, CAL-016), then the Version Packages release for 3.0.0; then CAL-011 (profiles collapse on a `vp` project). React Doctor follow-up: re-express its two scripts as `vp run` tasks.
- A Version Packages pull request for 3.0.0 will open from the CAL-012 Changeset; hold it until CAL-013 to CAL-016 have merged so the major ships once. The five follow-up issues named in ADR-0001 are open: #429 to #433. The unparseable-manifest MCP-level test waits on #429.
