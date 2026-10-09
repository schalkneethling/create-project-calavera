# STATUS

Updated: 2026-10-09

## Current phase and checkpoint

Increment 1 (sequencing map Section 0). Checkpoint 0 acceptance criteria are met on the evidence and await confirmation from Schalk: the reduced audit worksheet (CAL-001, #448) is complete and approved, every removal has an issue (#452 to #456, all merged), and the CQ1 and CQ2 ADRs are accepted (ADR-0009 merged in #530 on 2026-09-28; ADR-0001). Checkpoint 0 is not recorded as passed until Schalk confirms.

The Increment 1 exit condition (H0) is not met. `--new` (#532, ADR-0010), the profiles collapse (#535, ADR-0011), `docs/vite-plus.md` (CAL-019), and a real `vp create` fixture with an agent-first MCP flow test (#433) are on `main`. The Determinant first slice (`protected-branch-guard`, `agent-red-test-verification`) has no issue and no artifact yet, and the bootstrap readiness check (CAL-01y) has not been run as a recorded exercise.

## Completed this session

- `--new` exit 127 diagnosed (2026-10-09). `npx --package vite-plus vp create` fails with `sh: create-vite@latest: command not found` when npm is the project's package manager. The outer `npx` sets `npm_config_package=vite-plus`, Vite+ copies `process.env` into its template runner (`packages/cli/src/create/discovery.ts`), and the nested `npx create-vite@latest` inherits it. Reproduced with nested `npx` alone. A second source: Calavera started with `npx --package create-project-calavera` leaks the same setting through any runner. `pnpm create project-calavera -- --new` still uses `npx`, as ADR-0010 Decision 1 states.
- Upstream issue filed: voidzero-dev/vite-plus#2970. It offers a pull request; none is opened until a maintainer answers.
- Workaround documented (#670, PR #672): `docs/agent-first-calavera-workflow.md`, section "Known Issue: `vp create` Exits With Code 127 Through npx". Both documented commands were run end to end with exit 0. Removal is tracked in #671.
- The bootstrap always installs the base Calavera skill, although the Composer leaves `skill-calavera` unchecked by default. Filed #673 (decision: should the bootstrap follow the recipe) and #674 (bug, reproduced: `apply` with a skill-free recipe drops the skill from state and leaves `.agents/skills/calavera` unowned; depends on #673).
- The user's original run used a stale cached Calavera 4.0.2: unversioned `npm create project-calavera` reuses the npx cache without updating, whereas `@latest` and `npx --package` reinstall `latest`. Reproduced by seeding the cache. Filed #675 (p1).
- Filed #676 (decision: `--new` runner from the launching package manager, amends ADR-0010), #677 (agent worktrees break format and lint checks, p3), and #678 (feature, p3: remove Calavera's management files and keep the installed tooling).
- Twelve stale agent worktrees under `.claude/worktrees/` removed. Each was clean, and every local-only commit had a patch-identical commit on its remote branch. The branches remain. Repository-wide `pnpm format:all:check` passes again.
- Recorded late, landed on `main` between 2026-09-28 and 2026-10-06 without a status update: ADR-0009, ADR-0010, ADR-0011, and ADR-0013 accepted; `--new` with `--config` and recipe next steps; second dry run after apply reports no drift (#548); `github-repository-controls` refuses a workspace member (#550); Composer recipe seam (#525) and redesign (#571, #572); dev dependencies installed with `vp add -D` (#618); `quality` runs `vp check` and `vp test` (#622); supported Node.js range checked (#626). Releases v4.0.0 to v4.1.0 shipped between 2026-10-03 and 2026-10-05.

## In progress

- Open pull requests awaiting review, as stacks that merge base first:
  - #648 (#429) → #653 (#623) → #659 (#645) → #662 (#644) → #664 (#619)
  - #650 (#593) → #652 (#594)
  - #649 (#607) → #660 (#608)
  - #654 (#642) → #661 (#596)
  - Standalone on `main`: #672 (#670, this session) and #640 (Baseline data refresh).

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

- No Calavera change for the `--new` exit 127 failure: the defect is upstream, and ADR-0010 Decision 1 stands (`docs/adr/0010-new-delegates-scaffolding-to-vp-create.md`). Whether `--new` should choose its runner from the package manager that launched Calavera is not decided; no decision issue is open.
- ADR-0012 accepted by Schalk on 2026-10-09: `vp add -D` installs development dependencies in a Vite+-managed project (`docs/adr/0012-vp-add-installs-dev-dependencies-in-managed-projects.md`). It read "Proposed" after #620 shipped the decision on 2026-10-04.

## Next session starts with

- Confirm or reject Checkpoint 0 on the evidence above.
- Decide #673, then fix #674.
- #675 is p1: the documented npm command can run an old Calavera silently.
- Decide #676.
- Review the open pull request queue, starting with the base of each stack: #648, #650, #649, and #654.
- Watch voidzero-dev/vite-plus#2970; open the upstream pull request only after a maintainer answers.
- Toward H0: open the Determinant first-slice issue (CAL-01x) and run the bootstrap readiness check (CAL-01y) on a scratch `vp create` library monorepo.
