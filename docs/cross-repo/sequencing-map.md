# Cross-Repo Sequencing Map: css-evolve and Calavera

**Status:** Draft 1, 9 September 2026. Owner: Schalk Neethling. Both agents read this at the start of every session and update the status column when a handoff is delivered or consumed.
**Revised:** 7 November 2026, when handoff H0 was delivered and Section 0 was reset for the next increment.
**Purpose:** One timeline with every point where one project delivers a frozen surface the other consumes, so neither agent starts work that is blocked and neither invents the other side's API.

---

## 0. Current Increment

This section is the live plan. The briefs describe where the projects end up; this section says what is being worked now. It is rewritten at the end of each increment. Work only the current increment; anything else noticed becomes an issue.

**The next increment is not defined yet.** Increment 1 ended when handoff H0 was delivered on 7 November 2026. The owner reviews this skeleton and decides what the next increment contains. Apart from the Stryker decision recorded under Issues, every placeholder below reads "Owner to decide" and is filled in only by the owner.

**Name:** Owner to decide.

**Goal:** Owner to decide.

**Exit condition:** Owner to decide.

**Issues:** The Stryker integration work joins the next increment (owner decision, 2026-11-07). Any other issues: Owner to decide. The facts in the list below already exist and are listed so that the owner does not have to look them up; apart from the Stryker issues, listing an issue here does not place it in the next increment.

- The Stryker integration issues #733 (integrations add `.gitignore` and html-validate ignore entries), #734 (the Stryker integration), #735 (offer it in the Composer and MCP), and #736 (whether it supports `node:test` through the tap runner) are in the next increment, by the owner's decision of 2026-11-07. On 2026-10-22 the owner had decided that they wait until Increment 1 is finished, that is, until H0 is delivered (recorded on #732), and H0 is now delivered. The decision issue #732 was closed on 2026-11-05 because ADR-0014 answers it; ADR-0014 Decision 4 leaves the placement relative to Increment 1 to the owner, and the 2026-10-22 decision gives it: the Stryker work comes after H0, not inside Increment 1.
- #737 (remove the Stryker TypeScript 7 workaround) is blocked on a Stryker release that fixes stryker-mutator/stryker-js#6111.
- The deferred decisions #673 and #676, the friction issues the readiness check filed, and the blocked items #671, #737, and #746 are listed in `STATUS.md`.

**Explicitly not now:** Owner to decide.

**Increment 1 (closed) — Calavera becomes `vp`-aware and lean.** It started on 13 September 2026 and delivered H0 on 7 November 2026 with published `create-project-calavera` 6.1.0. The evidence is `docs/bootstrap-readiness-record.md`. The exit condition was: on a fresh `vp create` library monorepo, the Calavera agent-first flow from Claude Code (`inspect_project` → `compose_recipe` → `dry_run_apply` → `apply_recipe`) installs repository controls, governance and drift checks, EditorConfig, Knip, the selected Determinant gates, and the MCP registration, offers nothing Vite+ already provides, and a second `apply --dry-run` reports no drift.

- Revised by the owner on 2026-10-23 (ADR-0015): only `protected-branch-guard` was cataloged in this increment, so "the selected Determinant gates" meant the guard alone. `agent-red-test-verification` stays with the Determinant tracking issue (#744, closed on 2026-10-30; #746 holds the artifact).
- ADR-0010 (`--new` delegates scaffolding to `vp create`) is accepted (2026-09-28, #531), with an amendment proposed on 2026-10-21 under #688 and accepted on 2026-10-23. The decision issue #442 is closed.
- Checkpoint 1 is not claimed here. Its four criteria are in `docs/evolution-brief.md`; `STATUS.md` states which have an evidence source.
- Increment 1 left these out, and nothing in this section changes that: the Baseline engine API and Lightning CSS mapping (built when CSSE-015 needs them), #357 release verification extraction (before css-evolve's first publish), Playwright, a `gate` integration kind, packaging all Determinant gates, `dual-schema-validation` (when the `Diagnostic` schema exists), and the css-evolve integration (when there is a css-evolve to install).

CQ1 was resolved by Increment 1: Calavera provides no JS or TS toolchain to any project; a project that has not adopted Vite+ runs `vp create` or `vp migrate` first.

**Planned before this reset, not yet decided again by the owner.** The two paragraphs below are the expected shape from the original plan. The owner decides whether they still hold.

**Increment 2 — css-evolve bootstrapped through Calavera (Claude Code, css-evolve repository; starts when H0 is delivered; about one week).** `vp create`, then the Calavera flow above; every point of friction is a `dogfood` request back to Calavera; css-evolve Phase 0 follows on the resulting repository. Exit: css-evolve Checkpoint 0 with the added criterion that the repository was produced by Calavera and a second `apply --dry-run` reports no drift.

**Increment 3 —** planned after Increment 2 from both `STATUS.md` files. Expected shape: css-evolve Phase 1 on its own until CSSE-015, at which point Calavera builds the Baseline engine API.

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
2. The producing agent sets the handoff status here to `delivered <version> <date>` and records it in its `STATUS.md`.
3. Schalk carries the notice to the consuming repository (or the consuming agent reads this map at session start).
4. The consuming agent sets the status to `consumed <issue> <date>` when the consuming issue merges.

When a handoff is late: the producing agent records the slip and the new target here; the consuming agent continues with unblocked work and does not build against a guess.

## 5. Contacts and Escalation

Schalk is the only human in the loop for both repositories. An agent that needs a decision from the other side writes a cross-repo request in its own repository under `docs/cross-repo/requests/` (template in `docs/cross-repo/request-template.md`), stops the blocked issue, records the block in `STATUS.md`, and continues with unblocked work. Requests are answered in the same folder of the requesting repository once Schalk carries the answer across.
