# Cross-Repo Sequencing Map: css-evolve and Calavera

**Status:** Draft 1, 9 September 2026. Owner: Schalk Neethling. Both agents read this at the start of every session and update the status column when a handoff is delivered or consumed.
**Revised:** 7 November 2026, when handoff H0 was delivered and Section 0 was reset for the next increment; 13 November 2026, when Section 0 recorded what 6.2.0 shipped and the owner's choice of issues for the next release; 14 November 2026, when Section 0 recorded the `cli-experience` release's name, goal, exit condition, decisions, and waves.
**Purpose:** One timeline with every point where one project delivers a frozen surface the other consumes, so neither agent starts work that is blocked and neither invents the other side's API.

---

## 0. Current Increment

This section is the live plan. The briefs describe where the projects end up; this section says what is being worked now. It is rewritten at the end of each increment. Work only the current increment; anything else noticed becomes an issue.

**Current increment: the `cli-experience` release.** Increment 1 ended when handoff H0 was delivered on 7 November 2026. The owner chose this release's issues on 2026-11-13, and its name, goal, and exit condition on 2026-11-14.

**Name:** CLI experience.

**Goal:** From the first `--new` to removing Calavera, every command Calavera prints or documents runs as printed, and every summary it prints names each change once, grouped, so a person or an agent can act on it without rereading.

**Exit condition:** Every issue labeled `milestone: cli-experience` is closed or moved out by the owner, and one rehearsal on the release candidate, run by the automated rehearsal from #918 (`pnpm release:rehearse:cli`, in pinned mode, which `pnpm release:prepare` and `pnpm release:publish` run as a release gate on the exact candidate commit, and which the "CLI experience rehearsal" workflow also runs on the Version Packages pull request as an early signal), shows all of the following. The command's result table is the evidence; each numbered item below is one or more named checks in `scripts/rehearsal-checks.mjs`, so change that list when this one changes:

1. `--new` launched through npm, pnpm, Yarn 2 or later, and Bun, and with Calavera itself started through `npx --package create-project-calavera`, produces a project that `inspect_project` reports as `managed`, through the runner that launcher implies (#909, #740, #689, #671).
2. `--init`, `apply --dry-run`, `apply`, a second dry run that reports no change, and `clean --dry-run` each print every file, dependency, and artifact once, under headings, and their next-step commands work when pasted (#601, #602, #617, #331).
3. After apply and a commit through the Vite+ pre-commit hook, `git status` is clean: the cache folder does not appear, the apply summary says why, and the state file is committed as apply wrote it (#838, #841).
4. A Calavera older than the published `latest` prints the version notice (#675).
5. The drift tests pass for the MCP tool list and the agent prompt (#839, #840).

The owner asked on 2026-11-14 for the rehearsal to be automated, deterministic, and idempotent, so it can run more often than once per release (#918).

**Issues:** The release is the open issues labeled `milestone: cli-experience` (owner decision, 2026-11-13). That label is the list; this section does not copy it, so the two cannot drift apart.

- Shipped in `create-project-calavera` 6.2.0 on 12 November 2026: the Stryker integration work (#733, #734, #735, #736, #880, and #890), #846 with #844, and the list the owner approved on 2026-11-07 outside the increment plan (#829, #795 item 1, #830, #792, #790, #784, and #837). #795 stays open for items 2 to 6 and for the pnpm workspace install failure reported in its comments.
- #676 is decided ("follow the launcher") and recorded in the ADR-0010 amendment (#910). #909 implements it. #911 merged through #912.
- #740 is no longer blocked: Vite+ 1.4.0 (23 October 2026) is the first release that contains voidzero-dev/vite-plus#3181. Recommendation, not an owner decision: run the #740 probe before #909 and include Yarn 1, because moving the Yarn runner to `yarn create vite-plus` may change what #909 needs for Yarn 1. Any Yarn 1 change that follows needs its own issue, because #911 is closed.
- #671 waits on #689 only, because #688 is closed.

**Owner decisions of 2026-11-14,** each recorded on its issue:

- #689: remove `npm_config_package` and `npm_config_call` from the `vp create` child's environment only, and pass every other variable through unchanged. This does not reopen ADR-0010.
- #603: for `apply --config <outside path>`, the project root is the current directory with a `package.json`; otherwise refuse and name the directory, with no offer to create `package.json` and no workspace-ancestor check. #430 covers a different entry point, the `dry_run_apply` choices when the inspected directory has no manifest, so the two rules must not be merged.
- #617: one line per integration, with its package in parentheses only when the names differ; the full dependency list stays in `--json`.
- #663: an environment variable turns on stack traces.
- #838: write `.calavera/state.json` through the project's formatter.
- #841: the cache is not committed; Calavera writes the ignore line in a marked `.gitignore` block, and the apply summary says so.
- #678: the command is `eject`, and `package.json` scripts that call Calavera are reported, not removed. The ADR comes first.
- #602: the agent prompt follows `cd`; only `apply --dry-run` and `apply` wait for a recipe.
- #675: a CLI version notice, which needs a short ADR on its network behavior first.
- #840: the README's prompt is the single source.
- #247: split across the output issues, then closed with an inventory of what remains, or moved out.
- #354: kept, in wave 5, the last work wave, as a document only.

**Order of work** (planned with the owner on 2026-11-14; the owner chose one wave at a time)**:** six workstreams, grouped by the code they touch, because nearly every issue edits `packages/cli/src/index.js`. Within a workstream, issues run one after another; the workstreams run side by side. The owner chose to run one wave at a time: a wave ends when its pull requests merge, every open worktree rebases on `main`, and the owner hears the result before the next wave starts.

| Wave | A. Runner | B. Output                                             | C. Footprint | D. Catalog, MCP, and Composer | E. Detection | F. Standalone |
| ---- | --------- | ----------------------------------------------------- | ------------ | ----------------------------- | ------------ | ------------- |
| 1    | #740      | #840                                                  | #458         | #839                          | #432         | #230, #918    |
| 2    | #909      | #601                                                  | #841         | #228                          | #430         | #663          |
| 3    | #689      | #602                                                  | #838         | #580                          | —            | #398          |
| 4    | #671      | #617                                                  | #678 ADR     | #232                          | —            | #603          |
| 5    | —         | #331, #675 (ADR first), then #247 closed or moved out | #678         | —                             | #431         | #354          |

#918 starts in wave 1, because the exit rehearsal depends on it and it touches no CLI code. #232 follows #580 in column D because both change the Composer. When wave 5 has merged, the #918 rehearsal runs on the release candidate as the evidence for the exit condition, and the release follows.

**Explicitly not now:** #914 (Lighthouse) and #915 (Mergiraf) go to a later release (owner decision, 2026-11-14). Issues without the label stay out, including #673, #737 (blocked on stryker-mutator/stryker-js#6111), #746, #842, and #843.

**Increment 1 (closed) — Calavera becomes `vp`-aware and lean.** It started on 13 September 2026 and delivered H0 on 7 November 2026 with published `create-project-calavera` 6.1.0. The evidence is `docs/bootstrap-readiness-record.md`. The exit condition was: on a fresh `vp create` library monorepo, the Calavera agent-first flow from Claude Code (`inspect_project` → `compose_recipe` → `dry_run_apply` → `apply_recipe`) installs repository controls, governance and drift checks, EditorConfig, Knip, the selected Determinant gates, and the MCP registration, offers nothing Vite+ already provides, and a second `apply --dry-run` reports no drift.

- Revised by the owner on 2026-10-23 (ADR-0015): only `protected-branch-guard` was cataloged in this increment, so "the selected Determinant gates" meant the guard alone. `agent-red-test-verification` stays with the Determinant tracking issue (#744, closed on 2026-10-30; #746 holds the artifact).
- ADR-0010 (`--new` delegates scaffolding to `vp create`) is accepted (2026-09-28, #531), with an amendment proposed on 2026-10-21 under #688 and accepted on 2026-10-23. The decision issue #442 is closed.
- Checkpoint 1 is not claimed here. Its four criteria are in `docs/evolution-brief.md`. Only the first (a fresh `vp create` project is offered no JS or TS toolchain integration) has an evidence source, the readiness record; the other three have none yet.
- Increment 1 left these out, and nothing in this section changes that: the Baseline engine API and Lightning CSS mapping (built when CSSE-015 needs them), #357 release verification extraction (before css-evolve's first publish), Playwright, a `gate` integration kind, packaging all Determinant gates, `dual-schema-validation` (when the `Diagnostic` schema exists), and the css-evolve integration (when there is a css-evolve to install).

CQ1 was resolved by Increment 1: Calavera provides no JS or TS toolchain to any project; a project that has not adopted Vite+ runs `vp create` or `vp migrate` first.

**Planned before this reset, not yet decided again by the owner.** The two paragraphs below are the expected shape from the original plan. The owner decides whether they still hold.

**Increment 2 — css-evolve bootstrapped through Calavera (Claude Code, css-evolve repository; starts when H0 is delivered; about one week).** `vp create`, then the Calavera flow above; every point of friction is a `dogfood` request back to Calavera; css-evolve Phase 0 follows on the resulting repository. Exit: css-evolve Checkpoint 0 with the added criterion that the repository was produced by Calavera and a second `apply --dry-run` reports no drift.

**Increment 3 —** planned after Increment 2 from the records of both repositories. Expected shape: css-evolve Phase 1 on its own until CSSE-015, at which point Calavera builds the Baseline engine API.

## 1. Handoffs

| Id  | Producer   | Artifact (interface contract section)                                                                                              | Delivered at                                            | Consumer and consuming issue                                                                       | Blocked if it slips                                                                                                           | Status                                                         |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| H0  | Calavera   | `vp`-aware, lean Calavera with the first Determinant gates, verified on a scratch `vp create` project (Increment 1 exit condition) | Increment 1 end                                         | css-evolve CSSE-001 (Increment 2)                                                                  | css-evolve cannot start                                                                                                       | [delivered 6.1.0 2026-11-07](../bootstrap-readiness-record.md) |
| H1  | Calavera   | `calavera-baseline-core` API: resolve, feature availability, snapshot (I2.1 to I2.3), published version                            | Calavera CP2 (CAL-020, CAL-022)                         | css-evolve CSSE-015                                                                                | css-evolve Phase 1 cannot resolve `baselineTarget`; CSSE-016, CSSE-017 can proceed on a stub but must not merge with the stub | pending                                                        |
| H2  | css-evolve | `Diagnostic` and `DiagnosticReport` JSON and SARIF (I3), frozen                                                                    | css-evolve CP1 (CSSE-010)                               | Calavera CAL-033                                                                                   | Calavera Phase 3 diagnostics; Calavera can build the catalog entry (CAL-031) without it                                       | pending                                                        |
| H3  | Calavera   | Lightning CSS mapping (I2.4), published                                                                                            | Calavera CP2 (CAL-021, CAL-022)                         | css-evolve CSSE-041                                                                                | css-evolve Phase 4 Vite plugin ships without minifier reconciliation; overlay diagnostics unaffected                          | pending                                                        |
| H4  | css-evolve | Project surface declaration (I4): task names, `staged` entry, ESLint block, Vite plugin export, MCP server command                 | Names at css-evolve CP1; full surface at css-evolve CP4 | Calavera CAL-030, CAL-031, CAL-032                                                                 | Calavera Phase 3                                                                                                              | pending                                                        |
| H5  | css-evolve | Agent Plugins directory published (I5) and MCP tool surface frozen (I6)                                                            | css-evolve CP5 (CSSE-053, CSSE-054)                     | Calavera CAL-040                                                                                   | Calavera Phase 4                                                                                                              | pending                                                        |
| H6  | Calavera   | Integration metadata schema fields for `vp run` tasks and `staged` entries (I7) recorded in the contract                           | Calavera CP3 (CAL-030)                                  | css-evolve documentation only (README install section)                                             | none blocking                                                                                                                 | pending                                                        |
| H7  | Calavera   | Release verification extracted as a tool (#357)                                                                                    | Calavera Phase 6 (CAL-060)                              | css-evolve release process (new issue when H7 lands)                                               | none blocking; css-evolve uses its own verification until then                                                                | pending                                                        |
| H8  | css-evolve | Oxlint CSS language plugin (CSSE-063)                                                                                              | when oxc RFC #21936 ships                               | Calavera: apply C1 to the CSS lint scaffolding (Stylelint and ESLint CSS blocks become `vp check`) | none blocking; a Calavera removal issue is opened when H8 lands                                                               | pending                                                        |

## 2. Timeline

Phases run in parallel across the two repositories. Reading left to right within a row is the order of work; an arrow names the handoff that must have been delivered before the consuming issue starts.

Step 1 is complete: Increment 1 delivered H0 on 7 November 2026 (Section 1). The later rows are the original plan, which the owner has not yet decided again (Section 0).

| Step | Calavera repository                                                                    | css-evolve repository                                                                                                   | Handoffs                                                                                     |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1    | Increment 1: reduced audit, CQ2, `vp` detection, cleanup, first Determinant gates → H0 | waits for H0                                                                                                            | H0                                                                                           |
| 1b   | —                                                                                      | Increment 2: bootstrap through Calavera, then Phase 0 (Q1 spike, ADR-0002 scope, Q6 stub, migrate validator core) → CP0 | H0 consumed                                                                                  |
| 2    | Phase 1: `vp` detection, profile changes, removals → CP1                               | Phase 1: contract model, static checks, CLI, ESLint plugin (H1 stubbed if not yet delivered)                            | H2 delivered at css-evolve CP1; H4 names delivered at css-evolve CP1                         |
| 3    | Phase 2: engine API freeze, CQ5, Lightning mapping → CP2                               | Phase 1 continues; CSSE-015 waits for H1                                                                                | H1 and H3 delivered at Calavera CP2                                                          |
| 4    | Phase 3: CQ3, css-evolve catalog entry, MCP registration, diagnostics → CP3            | Phase 2: real-browser evaluation, engine matrix, expectation files, Vitest helper → CP2                                 | H1 → CSSE-015 merges; H2 → CAL-033; H4 names → CAL-030, CAL-031; H6 recorded at Calavera CP3 |
| 5    | Phase 5 (Playwright) may start; Phase 4 waits for H5                                   | Phase 3: probe runtime, directive, DevTools third-party tools adapter → CP3                                             | —                                                                                            |
| 6    | Phase 5 continues → CP5                                                                | Phase 4: Vite plugin, Lightning reconciliation, `vp` tasks → CP4                                                        | H3 → CSSE-041; H4 full surface delivered at css-evolve CP4 → CAL-031 finalizes               |
| 7    | Phase 4: css-evolve artifacts, #398 → CP4                                              | Phase 5: MCP server, skill, Agent Plugins directory, publish → CP5                                                      | H5 delivered at css-evolve CP5 → CAL-040                                                     |
| 8    | Phase 6: #357                                                                          | Phase 6: tokens, color assertions, WebDev Bench, Oxlint plugin when possible                                            | H7, H8 as they land                                                                          |

## 3. Parallelism and Stubs

- Calavera Phases 0, 1, 2, and 5 have no css-evolve dependency and should run ahead.
- css-evolve Phases 0, 2, and 3 have no Calavera dependency. Phase 1 depends on H1 only at CSSE-015; the rest of Phase 1 may proceed against a local stub of I2.1 to I2.3 that matches the contract types exactly. The stub is deleted when H1 lands; a PR that still imports the stub does not merge.
- Calavera Phase 3 may start the catalog entry (CAL-031) as soon as the H4 names are delivered at css-evolve CP1; it finalizes when the full surface lands at css-evolve CP4.
- Nothing in either project depends on H7 or H8.

## 4. Handoff Protocol

When a producer delivers a handoff:

1. The producing agent updates the interface contract if any detail changed before the freeze, marks the surface frozen, and records the published version.
2. The producing agent sets the handoff status here to `delivered <version> <date>`.
3. Schalk carries the notice to the consuming repository (or the consuming agent reads this map at session start).
4. The consuming agent sets the status to `consumed <issue> <date>` when the consuming issue merges.

When a handoff is late: the producing agent records the slip and the new target here; the consuming agent continues with unblocked work and does not build against a guess.

## 5. Contacts and Escalation

Schalk is the only human in the loop for both repositories. An agent that needs a decision from the other side writes a cross-repo request in its own repository under `docs/cross-repo/requests/` (template in `docs/cross-repo/request-template.md`), stops the blocked issue, records the block on that issue, and continues with unblocked work. Requests are answered in the same folder of the requesting repository once Schalk carries the answer across.
