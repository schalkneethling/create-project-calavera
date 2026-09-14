# STATUS

Updated: 2026-09-14

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Last checkpoint passed: none. Checkpoint 0 is in progress: the CQ2 ADR is accepted; the reduced audit worksheet (CAL-001, #448) is complete and awaits approval of its eleven `remove` rows.

## Completed this session

- CAL-001 reduced (#448): thirteen in-scope rows classified with evidence from real `vp` runs on the CAL-002 scratch projects and the Vite+ documentation. Result: eleven `remove` (Oxlint, Oxfmt, TypeScript configuration, ESLint flat config, Prettier, and the five rule packs), two `watch` (Stylelint, trigger H8 and the Oxlint CSS language plugin), one `keep` (React Doctor). Five removal issues proposed, CAL-012 to CAL-016; rule packs fold into their base removals because every pack entry includes its base integration. Deferred rows tracked in #449. Branch `cal-001-448-reduced-audit`.
- CAL-010 (#435): `detectVitePlus` in `packages/cli/src/vite-plus-detection.js`, a pure function over the project directory, with one `node --test` case per ADR-0001 fixture row plus purity and no-ancestor-config tests; `inspect_project` returns the `vitePlus` record and the four finding kinds; docs amended and a minor Changeset added. Red, green, and refactor landed as separate commits on branch `cal-010-435-vp-detection`. Awaiting pull request review.
- CAL-002 (#428): probed vite-plus 0.3.1 with real `vp create vite:library`, `vp create vite:monorepo`, and `vp migrate` runs, surveyed the `inspect_project` surface, and wrote `docs/adr/0001-vite-plus-detection-signal.md`. The ADR chooses the `vite-plus` dependency in the nearest ancestor `package.json` as the single primary signal, matching `vp`'s own self-check, with three corroborating signals recorded for diagnosis only, and specifies the `vitePlus` field and four finding kinds that `inspect_project` reports.

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

- Rows classified: 13 of 37. Removals opened: 0. Awaiting approval: 11.

## Open cross-repo requests

- none

## Decisions taken this session (with ADR link)

- CQ2 Vite+ detection signal: `docs/adr/0001-vite-plus-detection-signal.md` (Accepted 2026-09-13). Revised after review: the pin location is recorded for pnpm, npm, Yarn, and Bun, and the manifest-less directory case records the ancestor manifest so a later apply flow can offer create-here, apply-at-ancestor, or abandon at the `dry_run_apply` boundary.

## Next session starts with

- On approval of the audit rows: open CAL-012 to CAL-016 from the worksheet titles, then CAL-011 (profiles collapse on a `vp` project). React Doctor follow-up: re-express its two scripts as `vp run` tasks.
- The five follow-up issues named in the ADR are open: #429 to #433. The unparseable-manifest MCP-level test waits on #429.
