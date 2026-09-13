# Calavera: Evolution Brief

**Status:** Draft 1, 9 September 2026. Owner: Schalk Neethling.
**Purpose:** The single document a coding agent (Claude Code, or another harness) reads before doing any work on Calavera's Vite+ delegation and css-evolve integration. It records what Calavera is for, what has been decided, what is still open, how the work is sequenced, and the rules every change follows.
**Companions:** `css-evolve-evolution-brief.md` (the sibling brief), `cross-project-interface-contract.md` (the surfaces the two projects share), `cross-repo-sequencing-map.md` (handoff order), `calavera-catalog-audit-template.md` (Phase 0 deliverable). Read this brief and the interface contract first.

---

## 0. How to Use This Document

For an orchestrating agent:

1. Copy this file to `docs/evolution-brief.md` in the Calavera repository and link it from the root `AGENTS.md`.
2. Treat Section 3 (Decisions) as settled. Do not reopen a decision in a PR; open a decision issue instead and stop.
3. Treat Section 4 (Open Questions) as spikes. Each spike produces an ADR under `docs/adr/` and a recommendation; implementation waits for the ADR to be accepted.
4. The live plan is `cross-repo-sequencing-map.md` Section 0 (current increment); work only that. The phases in Section 6 are the long-horizon order, not a to-do list. Phase 0 (the catalog audit) gates everything after it. Each issue is one PR. Each PR answers one primary review question. Halt at every `CHECKPOINT` and wait for review and merge before continuing.
5. Anything css-evolve depends on is listed in `cross-project-interface-contract.md` with a freeze point. Do not change a frozen surface; write a cross-repo request instead (see `AGENTS.md`).
6. Never announce completion of a phase without the acceptance criteria passing in CI.
7. When this brief and the code disagree, the brief is the intent; open an issue rather than silently choosing.

---

## 1. Mission

Calavera is what happens after `vp create`. Vite+ owns how JavaScript and TypeScript are built, tested, linted, and formatted; Calavera owns the web-platform-quality and agent-readiness layer that Vite+ deliberately takes no position on, and it is the only thing that writes into a user's project on the user's behalf.

Three sentences an agent should be able to repeat back:

- Anywhere Calavera is fighting with or reimplementing something Vite or Vite+ already does well, Calavera steps aside, delegates, and that part is removed.
- Calavera keeps and sharpens what Vite+ will not do: a single declared Baseline target propagated to every consumer, CSS verification (css-evolve), HTML and accessibility checks, Playwright beyond Vitest browser mode, the agent artifact lifecycle, and release trust.
- Only the CLI writes into user projects; `dry_run_apply` is the approval boundary; local edits are never overwritten.

## 2. Current Scope (what exists on 9 September 2026)

Recorded here so the audit has a baseline and so an agent does not rediscover it.

- **Profiles:** Modern (Oxlint, Oxfmt, Stylelint, TypeScript), Classic (ESLint flat config, Prettier, Stylelint, TypeScript), Minimal (EditorConfig only).
- **Integration catalog:** React best practices (including React Doctor and JSX-A11y), imports and modules, promise safety, Node package rules, test rules, unused files and exports (Knip), HTML validation (html-validate), CSS Baseline, CSS property ordering, CSS property type validation, environment variable schema (Varlock), GitHub repository governance and drift checks.
- **AI artifacts:** skills, hooks, and subagents under a vendor-neutral `.agents/` structure, versioned as npm packages, deliberately not recorded in consumers' `package.json`, with an artifact resolver and an install, verify, and track path.
- **MCP server:** `inspect_project`, `list_profiles`, `list_integrations`, `list_ai_artifacts`, `compose_recipe`, `validate_recipe`, `explain_recipe`, `dry_run_apply`, `apply_recipe`; project-local registration for Claude Code, Claude Code, Cursor, and OpenCode.
- **Apply pipeline:** `calavera.config.json` recipe, managed state, local-edit preservation, omitted-script explanations, ownership notes, conflict detection (hard stop versus migration decision).
- **Baseline engine:** `calavera-baseline-core`, shared by the Baseline Target Explorer, the Composer (web UI, with a WebMCP surface), the CLI, and the MCP server.
- **Release machinery:** pnpm monorepo, 18 public packages, npm trusted publishing with signed provenance, release verification (pack inventory, manifest checks, registry probes, provenance count), dual-push to GitHub and Codeberg.
- **macOS menu-bar app:** artifact update notifications, terminal preference, copy-to-clipboard fallback.
- **Open issues that fit this brief:** #398 (`artifacts status` human-readable report), #357 (extract release verification as a project-agnostic tool).

## 3. Decisions (settled)

**C1. The litmus test.** Anywhere Calavera is fighting with or reimplementing something Vite or Vite+ already does well, Calavera steps aside, delegates to Vite+, and that part of the tooling is removed from Calavera. Removed means removed: no deprecated path, no compatibility shim, no "legacy" profile. This is the same test css-console applies to DevTools.

**C2. Calavera detects Vite+ and behaves accordingly.** In a project where `vp` manages the toolchain, Calavera does not scaffold linters, formatters, TypeScript configuration, or test runners for JavaScript and TypeScript, and does not write scripts that duplicate `vp` commands. It configures its remaining integrations as `vp run` tasks and `staged` entries. CQ2 decides the detection signal.

**C3. What Calavera keeps.** The Baseline engine, the apply pipeline and its safety properties, the artifact lifecycle, the MCP server, release verification, EditorConfig, HTML validation, Knip, Varlock, GitHub governance, and the CSS integrations (until Oxlint language plugins make css-evolve part of `vp check`, at which point the CSS lint scaffolding follows C1). The audit (Phase 0) applies C1 to every remaining entry and may add to the removal list; it may not remove anything from this list without a decision issue.

**C4. The Baseline engine is the single resolver.** `calavera-baseline-core` resolves `baselineTarget` (from `package.json`, falling back to `browserslist`) and exposes feature availability and the Lightning CSS `targets` mapping. css-evolve, its Vite plugin, and Calavera's own CSS Baseline integration all consume it. The engine's public API is a frozen surface in the interface contract.

**C5. css-evolve is a Calavera integration and a set of Calavera artifacts.** Calavera owns the catalog entry; css-evolve owns the packages. The entry installs the `vp run` tasks, the `staged` entry, the ESLint block, and, with consent, the MCP registration, and it catalogs the css-evolve Agent Plugins directory (skill, hooks, `mcp.json`) as versioned artifacts. Calavera's own MCP server does not proxy css-evolve tools; it installs css-evolve's MCP registration and stops.

**C6. Playwright is a Calavera integration.** End-to-end, visual regression, and accessibility testing beyond what Vitest browser mode covers is a Calavera concern, expressed as an integration that composes with `vp test` rather than replacing it. CQ4 scopes it.

**C7. Integrations are metadata over `vp` primitives.** An integration declares tasks, `staged` entries, dependencies, managed files, and ownership; scripts, custom logic, and follow-up guidance exist only where metadata cannot express the need. When Vite+ absorbs something an integration does, the integration is deleted, not defended.

**C8. Existing safety properties are invariants.** Only the CLI writes into projects; `dry_run_apply` is the approval boundary; local edits are preserved and never overwritten; artifacts are not recorded in `package.json`; conflicts are surfaced as hard stop or migration decision. No change in this brief may weaken any of these.

**C9. The Classic profile is decided by the audit, not by default.** Its components (ESLint, Prettier, TypeScript configuration) are candidates for removal under C1. The audit classifies each; Schalk approves removals. CQ1 covers what, if anything, remains for projects that have not adopted `vp`.

## 4. Open Questions (spikes, each ends in an ADR)

**CQ1. Non-`vp` projects.** Resolved by Increment 1 (see `cross-repo-sequencing-map.md` Section 0): Calavera provides no JS or TS toolchain to any project; a project that has not adopted Vite+ runs `vp create` or `vp migrate` first. Original question kept for the record: After delegation, what does Calavera offer a project that has not adopted Vite+: the Minimal profile plus the kept integrations and a recommendation to run `vp create` or `vp migrate`, or a reduced Classic path? Default proposal: the former; maintaining two toolchain worlds is the failure mode C1 exists to prevent. Blocks Phase 1.

**CQ2. Vite+ detection signal.** Which of these, in what precedence, marks a project as `vp`-managed: a `vite-plus` dependency, a `vp`-written toolchain pin, `vp` commands in `package.json` scripts, a Vite+ configuration file. Must be a pure function of the project directory with a documented result in `inspect_project`. Blocks Phase 1.

**CQ3. Integration schema for `vp` tasks and `staged` entries.** Whether the current integration metadata can express "add `vp run` task X" and "add `staged` entry Y", or whether the schema needs new fields. Blocks Phase 3 (css-evolve integration) and Phase 5 (Playwright).

**CQ4. Playwright integration scope.** Which of end-to-end, visual regression, accessibility (axe), and component testing Calavera sets up, how it composes with Vitest browser mode, and which parts are metadata versus managed files. Blocks Phase 5.

**CQ5. Lightning CSS mapping placement.** Confirm the mapping from a Baseline target to Lightning CSS `targets` and feature flags belongs in `calavera-baseline-core` (proposed) rather than in the css-evolve Vite plugin, and define its API per the interface contract. Blocks Phase 2 and css-evolve CSSE-041.

## 5. Target Shape After This Work

- `inspect_project` reports whether the project is `vp`-managed and which Calavera integrations are therefore not applicable.
- Profiles: Minimal and a `vp`-aware default; Modern and Classic exist only if the audit and CQ1 keep them.
- Catalog: the kept integrations from C3, plus css-evolve and Playwright.
- Artifacts: css-evolve's Agent Plugins directory cataloged and tracked; `artifacts status` (#398) shipped so updates are visible without the menu-bar app.
- `calavera-baseline-core`: public API frozen per the interface contract, including the Lightning CSS mapping.
- Documentation: an ADR per removal, and a `docs/vite-plus.md` page stating the litmus test and what Calavera does and does not do in a `vp` project.

## 6. Phases, Issues, Acceptance Criteria

Issue identifiers are `CAL-nnn`. One issue is one PR. Cross-repo handoffs are named `H<n>` and defined in `cross-repo-sequencing-map.md`.

### Phase 0: Catalog audit (one week)

- CAL-001 Complete `calavera-catalog-audit-template.md` for every profile component, integration, artifact, and MCP tool: keep, delegate to Vite+, or remove, with evidence (what `vp create`, `vp check`, `vp test`, or `vp fmt` already produces) and a proposed issue per removal.
- CAL-002 Spike CQ2 (detection signal). ADR.
- CAL-003 Spike CQ1 (non-`vp` projects). ADR.

`CHECKPOINT 0` — Acceptance: audit worksheet complete and approved by Schalk; every removal has an issue; ADRs for CQ1 and CQ2 accepted.

### Phase 1: Vite+ delegation (two to three weeks)

- CAL-010 Implement `vp` detection in `inspect_project` with the documented signal; tests for each signal and for false positives (a plain Vite project is not `vp`).
- CAL-011 Make profiles `vp`-aware: in a `vp` project, JS and TS lint, format, TypeScript, and test-runner scaffolding are not offered and are reported as `vp`-managed in `explain_recipe` and `dry_run_apply`.
- CAL-012 to CAL-01n Removal PRs from the audit, one per entry, each with an ADR and a test proving the entry no longer appears in `list_integrations` or `list_profiles`.
- CAL-019 `docs/vite-plus.md`.

`CHECKPOINT 1` — Acceptance: on a fresh `vp create` project, `compose_recipe` offers no JS or TS toolchain integrations; on a non-`vp` project the CQ1 outcome is what is offered; no removed entry is reachable through CLI, MCP, or Composer; existing safety-property tests pass unchanged.

### Phase 2: Baseline engine API (two weeks) — produces handoffs H1 and H3

- CAL-020 Freeze and publish the `calavera-baseline-core` public API per interface contract section I2 (resolve target, feature availability, snapshot version) with `type` exports and a documented semver policy.
- CAL-021 Spike CQ5, then implement the Lightning CSS mapping (interface contract I2.4) with tests, including the vitejs/vite #21911 cases.
- CAL-022 Publish; record H1 (engine API) and H3 (Lightning mapping) as delivered in the sequencing map.

`CHECKPOINT 2` — Acceptance: a consumer package can resolve a `baselineTarget` and obtain Lightning CSS targets with no other Calavera dependency; the API matches the interface contract exactly; version and snapshot are reported.

### Phase 3: css-evolve integration (two to three weeks) — consumes handoffs H2 and H4

- CAL-030 Spike CQ3 (schema for `vp run` tasks and `staged` entries). ADR; schema change if needed.
- CAL-031 Catalog entry for css-evolve: dependencies, `vp run` tasks (`lint:css`, `expect:css`, `probe:css` per the interface contract), `staged` entry, ESLint configuration block, ownership notes; metadata first, managed files only where required.
- CAL-032 MCP registration for the css-evolve server with explicit consent in `dry_run_apply`.
- CAL-033 Diagnostics: `dry_run_apply` and `apply_recipe` surface css-evolve's `Diagnostic` JSON (frozen at css-evolve Checkpoint 1) when the integration runs its post-apply check.

`CHECKPOINT 3` — Acceptance: on a `vp` project, applying the css-evolve integration produces the tasks, `staged` entry, and ESLint block; a seeded `var()` type mismatch is reported through Calavera's diagnostics; the MCP registration is written only after consent; re-apply preserves a local edit to the ESLint block.

### Phase 4: css-evolve artifacts (one to two weeks) — consumes handoff H5

- CAL-040 Catalog the css-evolve Agent Plugins directory (skill, hooks, `mcp.json`) as versioned artifacts through the existing resolver; install, verify, and track paths covered by tests.
- CAL-041 Ship #398 (`artifacts status`) so css-evolve artifact updates are visible from the CLI and MCP, not only the menu-bar app.

`CHECKPOINT 4` — Acceptance: `list_ai_artifacts` shows the css-evolve skill with version; `artifacts status` reports an available update when css-evolve publishes a new skill version; the artifact is not written to `package.json`.

### Phase 5: Playwright integration (two to three weeks)

- CAL-050 Spike CQ4. ADR.
- CAL-051 Playwright integration per the ADR, composing with `vp test` and Vitest browser mode; metadata over managed files.
- CAL-052 Accessibility assertions (axe) as an option of the same integration.

`CHECKPOINT 5` — Acceptance: on a `vp` project, the integration adds Playwright without duplicating Vitest configuration; `vp test` and the Playwright task both run in CI; removal is clean.

### Phase 6: Release trust (ongoing)

- CAL-060 #357: extract release verification as a project-agnostic tool; css-evolve adopts it for its own releases (cross-repo request to css-evolve when ready).

## 7. Working Agreements

- **One PR answers one primary review question.** Name the question in the PR description.
- **Test-driven.** Vitest for unit and integration; the apply pipeline's safety properties (C8) have tests that must not be weakened; Playwright where a browser is involved. A failing test precedes the implementation.
- **Command runner is `vp`** inside the Calavera monorepo itself.
- **Removals are complete.** No deprecated exports, no compatibility flags, no "legacy" mode. The ADR records why; the changelog records what.
- **Metadata before code.** An integration is added or changed by editing catalog metadata first; scripts, managed files, diagnostics, and follow-up guidance only where metadata cannot express the need (the documented contribution path).
- **Frozen surfaces are frozen.** Anything listed with a freeze point in the interface contract changes only through a cross-repo request and a version bump per the contract's semver rule.
- **Prose, comments, and docs follow the MDN writing style guide.** American spelling, no contractions in body prose.
- **Halt at checkpoints.**
- **Manual exercise harness for UI-less packages.** `calavera-baseline-core` and any new engine-level package ship a CLI entry point or a self-contained HTML document under `packages/<name>/harness/` that runs the package against stable fixtures; kept green as part of the package's test run.

## 8. Risks and Responses

**Vite+ absorbs something Calavera keeps (for example HTML validation or Knip).** Response: C7 makes the integration metadata; delete it and record an ADR.

**Detection false positives.** A plain Vite project mistaken for `vp` would lose its linting. Response: CAL-010 tests both directions; `inspect_project` prints the signal it matched.

**The audit stalls on judgment calls.** Response: the worksheet's evidence column is the tie-breaker; anything without evidence that `vp` does it well is a keep until evidence exists.

**css-evolve slips.** Response: Phases 0 to 2 and 5 do not depend on css-evolve; only Phases 3 and 4 wait on handoffs H2, H4, and H5.

## 9. Definition of Done

Calavera on a `vp create` project offers nothing Vite+ already does, and with one apply installs a declared Baseline target, css-evolve with its tasks and ESLint block, Playwright, the kept quality integrations, and the css-evolve agent artifacts, all tracked for updates and all removable cleanly. On a non-`vp` project it does what the CQ1 ADR says and nothing more.
