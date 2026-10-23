# STATUS

Updated: 2026-10-23

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Checkpoint 0 passed: Schalk confirmed it on 2026-10-22 on the recorded evidence. The reduced audit worksheet (CAL-001, #448) is complete and approved, every removal has an issue (#452 to #456, all merged), and the CQ1 and CQ2 ADRs are accepted (ADR-0009 merged in #530 on 2026-09-28; ADR-0001).

The Increment 1 exit condition (H0) is not met. `--new` (#532, ADR-0010, and the npm and Bun fix in #758), the profiles collapse (#535, ADR-0011), `docs/vite-plus.md` (CAL-019), a real `vp create` fixture with an agent-first MCP flow test (#433), dependency installs at a pnpm workspace root (#731, PR #739), and the Knip `.agents/**` ignore (#747, PR #751) are on `main`. The Determinant first slice is proposed as ADR-0015 (#743, PR #753, open), now revised after the owner's review: only `protected-branch-guard` is cataloged (#745), and apply wires it. The bootstrap readiness check (#749) has not been run as a recorded exercise.

## Completed this session

- Revised ADR-0015 for the owner's review of 2026-10-23 (PR #753). Apply now writes the guard's lines into `.vite-hooks/pre-commit`, `prepare-commit-msg`, and `pre-push` as marked blocks, and merges owned entries into `.claude/settings.json`, both through new manifest metadata and under dry-run approval. The protected branch is an input that Calavera asks for, with the current branch as the default, and the recipe records it. The ADR states how each C8 property holds for the new writes; no C8 test changes.
- Reviewed the Determinant scripts. The guard refuses every `git rebase` on a feature branch, because a rebase detaches HEAD; a probe confirmed it, and the copy fixes it by judging the branch in `rebase-merge/head-name`. The other findings are listed in the ADR's "Review of the copied scripts" section.
- Answered the four CodeRabbit findings on PR #753 in the same revision.

## In progress

- ADR-0015 (PR #753): revised, waiting for the owner's review.
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

- Calavera writes the protected-branch guard's lines into `.vite-hooks/*` through apply, replacing the 2026-10-22 ruling that the person adds them by hand. Decided by Schalk on 2026-10-23 (`docs/adr/0015-determinant-gates-as-skill-artifacts.md`, Decisions 4 and 5).
- Calavera asks for the protected branch and offers the current branch as the default. Decided by Schalk on 2026-10-23 (ADR-0015, Decision 6).
- Calavera wires the guard into Claude Code by merging owned entries into `.claude/settings.json`. Decided by Schalk on 2026-10-23 (ADR-0015, Decisions 5 and 7).
- `agent-red-test-verification` is deferred from Increment 1. Decided by Schalk on 2026-10-23 (ADR-0015, Decision 11; sequencing map Section 0).

## Next session starts with

- Review ADR-0015 (PR #753). When it is accepted, update #744, #745, #746, and #748 to match it: #745 gains the `wiring` metadata, the input, the two writers, and the script fixes; #746 waits; #748 installs one gate.
- #740 is unblocked: Vite+ 1.4.0 contains voidzero-dev/vite-plus#3181, and `pnpm create vite-plus@1.4.0` passed with no `vp` on `PATH`. Yarn still needs the probe.
- Finish Increment 1: #745, the Determinant tracking issue (#744), the readiness check (#749), then H0 (#750).
- Decide #689 and #676.
- #675 is p1: the documented npm command can run an old Calavera silently.
