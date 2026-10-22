# STATUS

Updated: 2026-10-22

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Checkpoint 0 acceptance criteria are met on the evidence and await confirmation from Schalk: the reduced audit worksheet (CAL-001, #448) is complete and approved, every removal has an issue (#452 to #456, all merged), and the CQ1 and CQ2 ADRs are accepted (ADR-0009 merged in #530 on 2026-09-28; ADR-0001). Checkpoint 0 is not recorded as passed until Schalk confirms.

The Increment 1 exit condition (H0) is not met. `--new` (#532, ADR-0010), the profiles collapse (#535, ADR-0011), `docs/vite-plus.md` (CAL-019), and a real `vp create` fixture with an agent-first MCP flow test (#433) are on `main`. The Determinant first slice (`protected-branch-guard`, `agent-red-test-verification`) has no issue and no artifact yet, and the bootstrap readiness check (CAL-01y) has not been run as a recorded exercise.

## Completed this session

- Stryker mutation testing set up for the CLI package (#723, PR #725). This is development tooling outside the current increment. `pnpm test:mutation` runs `@stryker-mutator/tap-runner` 10.0.0 over `packages/cli/scripts/*.test.mjs` and mutates only `packages/cli/src/**/*.js`, which is 25 files and 7,460 mutants. The dry run passes, and `pnpm quality` and every CI check on PR #725 pass.
- Two workarounds are in `stryker.config.mjs`. Stryker's tsconfig preprocessing calls the TypeScript JavaScript API that TypeScript 7 removed, so `tsconfigFile` points at a missing file. The line has a `WORKAROUND(@stryker-mutator/core)` marker that links stryker-mutator/stryker-js#6111. The redaction linear-time test is skipped under Stryker only, because instrumented code exceeds its 2,000 ms budget. The normal suite still runs it.
- The tap runner records coverage per test file, and only inside that file's own process. Code that tests reach only through a child process, such as the unsupported Node.js branch in `packages/cli/src/node-engine.js`, is reported as not covered, and a survivor there may be killed by a file that was not run. Issue #723 and the config record this.
- Filed #724 (spike: the Stryker TypeScript checker on TypeScript 7). Its TypeScript 7 mode still calls the TypeScript 6 JavaScript API, and it requires the tsconfig file that the workaround above skips.
- Recorded late, landed on `main` between 2026-10-09 and 2026-10-21 without a status update, and not reviewed in this session: every pull request listed as in progress on 2026-10-09 merged; ADR-0010 was amended to run `create-vite-plus` for npm and Bun, with links to voidzero-dev/vite-plus#3177; Claude Code plugins are hosted in a Calavera marketplace (#704); and the dependency-review plugin reports failing checks first (#713).

## In progress

- #725 (#723, this session): all checks pass, and CodeRabbit left no actionable comments. It waits for Schalk to merge.
- #722 (Version Packages) and Dependabot pull requests #726 to #730 are open.

## Blocked

- #671 waits on a Vite+ release that fixes voidzero-dev/vite-plus#2970.

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

- Stryker uses the tap runner, not the command runner. On a sample of 72 mutants in `node-engine.js` and `repository-root.js`, the command runner timed out on every mutant, and Stryker counts timeouts as detected, so it reported a meaningless 100% in 3 minutes 52 seconds. The tap runner reported 64 killed, 4 timed out, 1 survived, 2 not covered, and 1 runtime error in 47 seconds. No ADR: this is development tooling, and the evidence is in #723 and PR #725.
- The Stryker TypeScript checker is deferred to #724. No ADR.

## Next session starts with

- Confirm or reject Checkpoint 0 on the evidence above.
- Merge #725 if the review holds. A full mutation run has not been done, and whether the 4 sample timeouts are real or caused by CPU load is unverified.
- Decide #673, then fix #674.
- #675 is p1: the documented npm command can run an old Calavera silently.
- Decide #676, and check it against the 2026-10-21 amendment to ADR-0010.
- Watch voidzero-dev/vite-plus#2970; open the upstream pull request only after a maintainer answers.
- Toward H0: open the Determinant first-slice issue (CAL-01x) and run the bootstrap readiness check (CAL-01y) on a scratch `vp create` library monorepo.
