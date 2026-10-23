# STATUS

Updated: 2026-10-23

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Checkpoint 0 passed: Schalk confirmed it on 2026-10-22 on the recorded evidence. The reduced audit worksheet (CAL-001, #448) is complete and approved, every removal has an issue (#452 to #456, all merged), and the CQ1 and CQ2 ADRs are accepted (ADR-0009 merged in #530 on 2026-09-28; ADR-0001).

The Increment 1 exit condition (H0) is not met. `--new` (#532, ADR-0010), the profiles collapse (#535, ADR-0011), `docs/vite-plus.md` (CAL-019), a real `vp create` fixture with an agent-first MCP flow test (#433), dependency installs at a pnpm workspace root (#731, PR #739), and the Knip `.agents/**` ignore (#747, PR #751) are on `main`. The Determinant first slice is proposed as ADR-0015 (#743, PR #753, open), with its artifacts in #745 and #746. The bootstrap readiness check (#749) has not been run as a recorded exercise.

## Completed this session

- `--new` works again through npm (#758, pull request open). Since Vite+ 1.3.0, a plain `npm create project-calavera -- --new` exited with code 127 every time, and Vite+ 1.4.0, published on 2026-10-23, does not change that. `--new` now runs `npm create vite-plus@latest --` for npm and `bunx create-vite-plus@latest` for Bun. pnpm and Yarn are unchanged until #740. The confirmation names the package manager Vite+ will use. An npm exit 127 now gets its own hint, which names the remaining cause (#689) and its workaround, instead of the npx cache advice, so #719 is settled. Probes with Vite+ 1.4.0 and an end-to-end run of the local build are recorded in ADR-0010.
- Stryker on the lines #758 changes, with `new-flag.test.mjs` as the only test file: the first run scored 96.15% (50 killed, 2 survived). Both survivors showed missing assertions, which the tests now make. The second run scored 100% (42 killed, 10 timed out, 0 survived). The full `pnpm test:mutation` run was not repeated.
- Filed #758.

## In progress

- #758: pull request open for review.
- ADR-0015 (PR #753) and #722 (Version Packages) are open.

## Blocked

- #671 (remove the exit 127 known-issue section) waits on #689. Vite+ closed voidzero-dev/vite-plus#2970 without a change, so no Vite+ release will fix it.
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

- The ADR-0010 amendment that runs `create-vite-plus` for npm and Bun is accepted, decided by Schalk on 2026-10-23 (`docs/adr/0010-new-delegates-scaffolding-to-vp-create.md`, "Amendment: `create-vite-plus` for the npm and Bun Runners").
- The Bun row is `bunx create-vite-plus@latest`, not the proposed `bun create vite-plus@latest`, because `bun create` runs a local `.bun-create/vite-plus@latest` template from the working directory or the home directory in place of the package. Decided by Schalk on 2026-10-23; the evidence is in the same ADR under "Implementation Evidence".

## Next session starts with

- Review and merge the #758 pull request.
- #740 is unblocked: Vite+ 1.4.0 contains voidzero-dev/vite-plus#3181, and `pnpm create vite-plus@1.4.0` passed with no `vp` on `PATH`. Yarn still needs the probe.
- Finish Increment 1: ADR-0015 (#743), its artifacts (#745, #746), the Determinant tracking issue (#744), the readiness check (#749), then H0 (#750).
- Decide #689 and #676.
- #675 is p1: the documented npm command can run an old Calavera silently.
