# STATUS

Updated: 2026-10-22

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Checkpoint 0 passed: Schalk confirmed it on 2026-10-22 on the recorded evidence. The reduced audit worksheet (CAL-001, #448) is complete and approved, every removal has an issue (#452 to #456, all merged), and the CQ1 and CQ2 ADRs are accepted (ADR-0009 merged in #530 on 2026-09-28; ADR-0001).

The Increment 1 exit condition (H0) is not met. `--new` (#532, ADR-0010), the profiles collapse (#535, ADR-0011), `docs/vite-plus.md` (CAL-019), a real `vp create` fixture with an agent-first MCP flow test (#433), and dependency installs at a pnpm workspace root (#731, PR #739) are on `main`. The Determinant first slice (`protected-branch-guard`, `agent-red-test-verification`) has no issue and no artifact yet; its scripts live in https://github.com/schalkneethling/determinant. The bootstrap readiness check (CAL-01y) has not been run as a recorded exercise.

## Completed this session

- Checkpoint 0 recorded as passed (#741).
- Stryker mutation testing set up for the CLI package (#723, PR #725, merged). `pnpm test:mutation` runs `@stryker-mutator/tap-runner` 10.0.0 over `packages/cli/scripts/*.test.mjs` and mutates only `packages/cli/src/**/*.js`. Two workarounds are in `stryker.config.mjs`: `tsconfigFile` points at a missing file because Stryker's tsconfig preprocessing needs the TypeScript JavaScript API that TypeScript 7 removed (stryker-mutator/stryker-js#6111), and the redaction linear-time test is skipped under Stryker only. The tap runner records coverage per test file, inside that file's process only, so code reached only through child processes can show as not covered or as a false survivor.
- Researched Stryker as a Calavera integration: feasible for projects Vite+ manages, using the Vitest runner. ADR-0014 (PR #738, merged) accepts it as an optional integration that uses the project's runner rather than adding one, offered only where Calavera delegates to Vite+, and run only through `test:mutation`.
- Dependency installs at a pnpm workspace root now pass `-w` (#731, PR #739, merged). The install previously failed with `ERR_PNPM_ADDING_TO_ROOT` after Calavera had written its files. This was on H0's path, because the exit condition installs Knip on a `vp create` library monorepo.
- Filed #724 (spike: Stryker TypeScript checker on TypeScript 7), #732 (Stryker scope decision, open for its documentation criteria), #733 to #736 (the Stryker integration: ignore entries, catalog entry, Composer and MCP, `node:test` support), and #737 (remove the TypeScript 7 workaround once Stryker supports it).
- Recorded late, landed on `main` between 2026-10-09 and 2026-10-21 without a status update, and not reviewed in this session: every pull request listed as in progress on 2026-10-09 merged; ADR-0010 was amended to run `create-vite-plus` for npm and Bun, with links to voidzero-dev/vite-plus#3177; Claude Code plugins are hosted in a Calavera marketplace (#704); and the dependency-review plugin reports failing checks first (#713).

## In progress

- Planning the rest of Increment 1: CAL-01x (Determinant first slice), the Determinant tracking issue, and CAL-01y (bootstrap readiness check).
- #722 (Version Packages) and Dependabot pull request #730 are open.

## Blocked

- #671 waits on a Vite+ release that fixes voidzero-dev/vite-plus#2970.
- #737 waits on a Stryker release that fixes stryker-mutator/stryker-js#6111.

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

- Checkpoint 0 passed, confirmed by Schalk on 2026-10-22.
- Stryker is accepted as an optional integration for projects Vite+ manages (`docs/adr/0014-stryker-mutation-testing-scope.md`).
- The Stryker integration issues (#733 to #736) wait until Increment 1 is finished, that is, until H0 is delivered. Decided by Schalk on 2026-10-22 and recorded on #732.
- This repository's own Stryker setup uses the tap runner, not the command runner: on a 72-mutant sample the command runner timed out on every mutant and reported a meaningless 100%. No ADR; the evidence is in #723 and PR #725.

## Next session starts with

- Finish Increment 1: CAL-01x, the Determinant tracking issue, then CAL-01y on a scratch `vp create` library monorepo, then H0.
- Decide #673, then fix #674.
- #675 is p1: the documented npm command can run an old Calavera silently.
- Decide #676, and check it against the 2026-10-21 amendment to ADR-0010.
- Watch voidzero-dev/vite-plus#2970; open the upstream pull request only after a maintainer answers.
