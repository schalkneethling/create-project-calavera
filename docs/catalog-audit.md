# Calavera Catalog Audit (Phase 0 worksheet)

**Status:** Template, 9 September 2026. Claude Code completes it as CAL-001; Schalk approves every row classified `remove` or `delegate`.
**Purpose:** Apply the litmus test (C1) to every profile component, integration, artifact, and MCP tool Calavera ships today, with evidence, so Phase 1 removals are mechanical and defensible.

---

## 1. Classification rules

Each row receives exactly one classification.

- **keep** — Vite+ does not do this and is not expected to. Calavera keeps and, where the brief says so, sharpens it.
- **delegate** — Vite+ does this well in a `vp`-managed project. Calavera stops offering it in `vp` projects; the CQ1 ADR decides what happens in non-`vp` projects. A `delegate` row still produces a removal issue for the `vp` path.
- **remove** — Vite+ does this well everywhere it matters, or the entry no longer earns its place regardless of Vite+. Calavera deletes it entirely: no deprecated path, no flag, no legacy profile.
- **watch** — Vite+ does not do this today but has announced or is visibly moving toward it. Calavera keeps it as metadata only and records the signal to re-audit on.

Tie-breaker: a row without evidence that Vite+ does the thing well is `keep` until evidence exists. Evidence means a Vite+ release note, documentation page, or reproducible `vp` command output, cited with a URL or a command transcript. Opinion is not evidence.

A row may not be classified `keep` if the only reason is that Calavera's implementation is nicer than Vite+'s. Preference is not a reason to fight the toolchain.

## 2. Evidence sources

- Vite+ beta announcement and release notes (VoidZero): what `vp create`, `vp check`, `vp test`, `vp fmt`, `vp lint`, `vp pack`, `vp migrate`, and `staged` produce.
- Oxlint and Oxfmt documentation and compatibility tables (oxc.rs): which rules and languages are covered; CSS is not covered until the Language Plugins RFC ships.
- A fresh `vp create` project inspected in a scratch directory: list its generated files, scripts, and configuration; this is the strongest evidence for `delegate`.
- Calavera's own `list_profiles`, `list_integrations`, and `list_ai_artifacts` output: the authoritative list of rows.

## 3. Worksheet

One row per entry. Fill every column. Add rows for anything `list_integrations` or `list_ai_artifacts` reports that is not pre-listed below.

| Entry                                                        | Kind              | What it does today | Does Vite+ do this? (evidence)                 | Classification | Non-`vp` treatment (per CQ1) | Removal or follow-up issue | Notes                                                                                         |
| ------------------------------------------------------------ | ----------------- | ------------------ | ---------------------------------------------- | -------------- | ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Modern profile: Oxlint                                       | profile component |                    |                                                |                |                              |                            |                                                                                               |
| Modern profile: Oxfmt                                        | profile component |                    |                                                |                |                              |                            |                                                                                               |
| Modern profile: Stylelint                                    | profile component |                    | Not until Oxlint language plugins (RFC #21936) |                |                              |                            | CSS lane; see H8                                                                              |
| Modern profile: TypeScript config                            | profile component |                    |                                                |                |                              |                            |                                                                                               |
| Classic profile: ESLint flat config                          | profile component |                    |                                                |                |                              |                            | `@eslint/css` remains the CSS lint host for css-evolve; distinguish JS ESLint from CSS ESLint |
| Classic profile: Prettier                                    | profile component |                    |                                                |                |                              |                            | Calavera already rejects Oxfmt plus Prettier                                                  |
| Classic profile: Stylelint                                   | profile component |                    |                                                |                |                              |                            |                                                                                               |
| Classic profile: TypeScript config                           | profile component |                    |                                                |                |                              |                            |                                                                                               |
| Minimal profile: EditorConfig                                | profile component |                    |                                                |                |                              |                            |                                                                                               |
| React best practices (incl. React Doctor, JSX-A11y)          | integration       |                    |                                                |                |                              |                            |                                                                                               |
| Imports and modules                                          | integration       |                    | Oxlint rule coverage?                          |                |                              |                            |                                                                                               |
| Promise safety                                               | integration       |                    | Oxlint rule coverage?                          |                |                              |                            |                                                                                               |
| Node package rules                                           | integration       |                    | Oxlint rule coverage?                          |                |                              |                            |                                                                                               |
| Test rules                                                   | integration       |                    | Oxlint / Vitest rule coverage?                 |                |                              |                            |                                                                                               |
| Knip (unused files, deps, exports)                           | integration       |                    |                                                |                |                              |                            |                                                                                               |
| HTML validation (html-validate)                              | integration       |                    |                                                |                |                              |                            |                                                                                               |
| CSS Baseline                                                 | integration       |                    |                                                |                |                              |                            | Consumer of I2; likely `keep` until H8                                                        |
| CSS property ordering                                        | integration       |                    |                                                |                |                              |                            |                                                                                               |
| CSS property type validation                                 | integration       |                    |                                                |                |                              |                            | Superseded by css-evolve integration (CAL-031); classify accordingly                          |
| Varlock (env schema)                                         | integration       |                    |                                                |                |                              |                            |                                                                                               |
| GitHub governance and drift checks                           | integration       |                    |                                                |                |                              |                            |                                                                                               |
| `package.json` scripts management (`quality` composite)      | pipeline feature  |                    | `vp check` / `staged`?                         |                |                              |                            | Distinguish composing Calavera-owned tasks from duplicating `vp` commands                     |
| `.agents/` skills                                            | artifact class    |                    |                                                |                |                              |                            |                                                                                               |
| `.agents/` hooks                                             | artifact class    |                    |                                                |                |                              |                            |                                                                                               |
| `.agents/` subagents                                         | artifact class    |                    |                                                |                |                              |                            |                                                                                               |
| `css-tokens` skill                                           | artifact          |                    |                                                |                |                              |                            | Relationship to css-evolve tokens (D9) to be decided; record proposal                         |
| MCP: `inspect_project`                                       | MCP tool          |                    |                                                |                |                              |                            | Gains `vp` detection (CAL-010)                                                                |
| MCP: `list_profiles`                                         | MCP tool          |                    |                                                |                |                              |                            |                                                                                               |
| MCP: `list_integrations`                                     | MCP tool          |                    |                                                |                |                              |                            |                                                                                               |
| MCP: `list_ai_artifacts`                                     | MCP tool          |                    |                                                |                |                              |                            |                                                                                               |
| MCP: `compose_recipe` / `validate_recipe` / `explain_recipe` | MCP tool          |                    |                                                |                |                              |                            |                                                                                               |
| MCP: `dry_run_apply` / `apply_recipe`                        | MCP tool          |                    |                                                |                |                              |                            | Safety property; `keep`                                                                       |
| Composer web UI (incl. WebMCP surface)                       | surface           |                    |                                                |                |                              |                            |                                                                                               |
| Baseline Target Explorer                                     | surface           |                    |                                                |                |                              |                            | Consumer of I2                                                                                |
| macOS menu-bar app                                           | surface           |                    |                                                |                |                              |                            | Out of Vite+ scope; `keep`; see #398                                                          |
| Release verification                                         | pipeline feature  |                    | `vp pack`?                                     |                |                              |                            | See #357 (H7)                                                                                 |

## 4. Summary (fill after the table)

- Rows: N. keep: n. delegate: n. remove: n. watch: n.
- Removal issues opened: list.
- Rows awaiting Schalk's approval: list.
- Re-audit triggers recorded for `watch` rows: list (for example "Oxlint language plugins ship" for the CSS lane; "Vite+ adds HTML validation" for html-validate).

## 5. Sign-off

| Role        | Name             | Date |
| ----------- | ---------------- | ---- |
| Prepared by | Claude Code      |      |
| Approved by | Schalk Neethling |      |
