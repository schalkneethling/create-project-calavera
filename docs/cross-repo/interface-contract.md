# Cross-Project Interface Contract: css-evolve and Calavera

**Status:** Draft 1, 9 September 2026. Owner: Schalk Neethling. Both agents read this before touching any surface listed here.
**Purpose:** Name every surface one project depends on from the other, who owns it, when it freezes, and how it changes. If a surface is not in this document, neither project may depend on it.

---

## 0. Rules

1. **Owner changes, consumer requests.** Only the owning project edits a surface. The consuming project asks for a change through a cross-repo request (see each repository's `AGENTS.md`).
2. **Freeze points.** Each surface names the checkpoint at which it freezes. Before the freeze, the owner may change it freely and must update this document. After the freeze, changes follow the semver rule below and a request.
3. **Semver rule.** Additive changes (new optional field, new function, new tool) are minor versions and require no consumer change. Removals, renames, type changes, and semantic changes are major versions, are announced in a cross-repo request at least one phase before they ship, and the consumer pins the previous major until it migrates.
4. **This document is the source of truth for the surface, not the code.** When code and this document disagree, the code is wrong until a request changes the document.
5. **Types, not prose, where possible.** Every surface has a TypeScript `type` sketch. The owner keeps a published `.d.ts` that matches it; conformance is tested on both sides.

---

## I1. `baselineTarget` (owner: Calavera; consumers: css-evolve, Vite plugin, Modern Web Guidance, `@eslint/css`)

**Location:** `package.json`, top-level key `baselineTarget`. Fallback: `browserslist` (key or file). Absent both: `"widely"`.

**Values:**

```ts
export type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type FourDigitYear = `${Digit}${Digit}${Digit}${Digit}`;

export type BaselineTargetValue =
  | "widely"          // Baseline Widely available
  | "newly"           // Baseline Newly available
  | FourDigitYear;    // a four-digit year, meaning "features that became Baseline Newly available in or before this year"
```

**Semantics:** a feature is *available* under a target when its Baseline status, according to the pinned `web-features` snapshot, satisfies the target. `browserslist` fallback maps to the most conservative Baseline target whose browser set is a superset of the browserslist query; the engine reports which fallback it used.

**Freeze:** Calavera Checkpoint 2.

## I2. `calavera-baseline-core` public API (owner: Calavera; consumers: css-evolve core, css-evolve Vite plugin, Calavera CSS Baseline integration)

Package: `@schalkneethling/calavera-baseline-core` (confirm exact published name at Calavera Checkpoint 2 and record it here).

### I2.1 Resolution

```ts
export type ResolvedBaselineTarget = {
  target: BaselineTargetValue;
  source: "package.json" | "browserslist" | "default";
  snapshot: { webFeaturesVersion: string; generatedAt: string };
};

export function resolveBaselineTarget(options: { cwd: string }): Promise<ResolvedBaselineTarget>;
```

### I2.2 Feature availability

```ts
export type FeatureAvailability = {
  featureId: string;                 // web-features id, e.g. "function", "if", "anchor-positioning"
  available: boolean;
  status: "widely" | "newly" | "limited" | "unknown";
  since?: string;                    // ISO date the feature reached the reported status
};

export function isFeatureAvailable(featureId: string, target: BaselineTargetValue): FeatureAvailability;
export function featuresForCss(css: string): string[]; // web-features ids referenced by the stylesheet, best effort; css-evolve may supply its own detector and pass ids directly
```

### I2.3 Snapshot

```ts
export function snapshotInfo(): { webFeaturesVersion: string; generatedAt: string };
```

### I2.4 Lightning CSS mapping (added in Calavera Phase 2, CAL-021)

```ts
export type LightningCssMapping = {
  targets: Record<string, number>;   // Lightning CSS browser targets object
  include?: number;                  // Lightning CSS Features bitmask to force-include
  exclude?: number;                  // Lightning CSS Features bitmask to exclude
  notes: string[];                   // human-readable explanation of each decision
};

export function lightningCssMapping(target: BaselineTargetValue): LightningCssMapping;
```

Test fixtures for I2.4 must include the vitejs/vite #21911 cases (`::scroll-marker`, `::scroll-button()`, `:target-current`, `::search-text`) under targets that admit and do not admit them.

**Freeze:** I2.1 to I2.3 at Calavera Checkpoint 2 (handoff H1). I2.4 at Calavera Checkpoint 2 (handoff H3).

## I3. css-evolve `Diagnostic` (owner: css-evolve; consumers: Calavera apply diagnostics, ESLint and Stylelint plugins, MCP server, Vite plugin, CI)

```ts
export type Position = { line: number; column: number }; // 1-based line, 1-based column

export type Subject =
  | { kind: "function-call"; name: string; args: string[] }
  | { kind: "declaration"; selector: string; property: string }
  | { kind: "custom-property"; selector: string; name: string }
  | { kind: "pseudo-element"; selector: string; pseudo: string; property: string };

export type Diagnostic = {
  code: string;                       // stable identifier, kebab-case, documented in css-evolve docs/diagnostics.md
  severity: "error" | "warning" | "info";
  message: string;
  loc: { file: string; start: Position; end: Position };
  subject?: Subject;
  expected?: string;
  actual?: string;
  engine?: "chromium" | "webkit" | "firefox";
  help?: string;
  docsUrl?: string;
  fixable: boolean;
};

export type DiagnosticReport = {
  version: "1";                       // report format version; bumps only on a breaking change to this type
  tool: { name: "css-evolve"; version: string };
  baselineTarget?: ResolvedBaselineTarget;
  diagnostics: Diagnostic[];
  summary: { errors: number; warnings: number; infos: number; skipped: number };
};
```

**Formats:** `--format json` emits one `DiagnosticReport`. `--format sarif` emits SARIF 2.1 where each `Diagnostic` is a `result` with `ruleId = code`, `level` mapped from `severity`, and `properties` carrying `subject`, `expected`, `actual`, and `engine`.

**Exit codes:** 0 no diagnostics at or above the configured failure severity; 1 diagnostics present; 2 input or configuration failure.

**Freeze:** css-evolve Checkpoint 1 (handoff H2).

## I4. css-evolve project surface Calavera installs (owner: css-evolve declares; Calavera authors the catalog entry)

What css-evolve requires in a consuming project. Calavera expresses this as catalog metadata; css-evolve documents it here and in its README and does not ship scaffolding.

| Item | Value |
|---|---|
| Dependencies (dev) | `@schalkneethling/css-evolve-cli`, `@schalkneethling/css-evolve-eslint-plugin`, `@schalkneethling/css-evolve-vite-plugin`; `@schalkneethling/css-evolve-browser` when expectations are used |
| `vp run` tasks | `lint:css` → `css-evolve check`; `expect:css` → `css-evolve expect`; `probe:css` → `css-evolve probe` (development only) |
| `staged` entry | `*.css` → `css-evolve check --format json` |
| Composite script | `lint:css` is appended to Calavera's generated `quality` script |
| ESLint | `@eslint/css` language registration plus `css-evolve/*` rules in the flat config, added as a managed block with ownership notes |
| Vite | `cssEvolve()` plugin in `vite.config`, added as a managed block; reads I2 through Calavera's engine |
| MCP registration | `css-evolve-mcp` over stdio, project-local, written only after consent in `dry_run_apply` |
| Configuration | none beyond `baselineTarget` (I1); css-evolve has no config file of its own in 1.0 |

**Freeze:** css-evolve Checkpoint 4 (handoff H4). Task and script names freeze earlier, at css-evolve Checkpoint 1, so Calavera's CQ3 spike can proceed.

## I5. css-evolve Agent Plugins directory (owner: css-evolve; consumer: Calavera artifact resolver)

Published as `@schalkneethling/css-evolve-agent-plugin`. Layout follows Agent Plugins 1.0:

```
plugin.json                 name, version, description, compatibility
skills/
  css-evolve/
    SKILL.md                Agent Skills spec; description under the length cap
hooks/                      optional; post-edit hook running `css-evolve check` on changed CSS
mcp.json                    stdio server definition for css-evolve-mcp
.claude-plugin/             Claude Code marketplace manifest (mirrors plugin.json)
```

**Calavera expectations:** the package is resolvable by the artifact resolver, versioned independently of the css-evolve runtime packages, never written to a consumer's `package.json`, and its `plugin.json` version is what `artifacts status` compares.

**Freeze:** css-evolve Checkpoint 5 (handoff H5).

## I6. css-evolve MCP server tool surface (owner: css-evolve; consumer: any agent; Calavera installs only)

Tools (final list decided at css-evolve Q7; recorded here when frozen): `validate`, `expect`, `probe`, `explain`, `baselineStatus`, `generateProperties`. Every tool returns `{ report: DiagnosticReport; summary: string }`. Calavera does not proxy or wrap these tools.

**Freeze:** css-evolve Checkpoint 5.

## I7. Calavera integration metadata schema (owner: Calavera; consumer: css-evolve documentation only)

css-evolve does not read this schema; it exists here so css-evolve's I4 declaration is written in terms Calavera can express. After CQ3, Calavera records here the fields used for `vp run` tasks and `staged` entries.

**Freeze:** Calavera Checkpoint 3.

## I8. Glossary (shared vocabulary; both projects use these words with these meanings)

- **Contract** (css-evolve): a checkable statement about CSS: a registered property type, a function signature, a token definition, a Baseline target, an expectation, or a probe.
- **Expectation** (css-evolve): a dynamic contract with an asserted value, checked in a real browser engine.
- **Probe** (css-evolve): a dynamic contract without an asserted value, evaluated on a live page during development; promoted to an expectation by adding the assertion.
- **Real-browser evaluation** (css-evolve): computing a CSS value by asking an engine, via Playwright; the only source of truth for computed CSS.
- **Diagnostic** (css-evolve): one finding in the I3 shape.
- **Integration** (Calavera): a catalog entry that installs a tool into a project as metadata over `vp` primitives.
- **Artifact** (Calavera): a versioned skill, hook, subagent, or MCP registration installed under `.agents/` and tracked for updates.
- **Recipe** (Calavera): `calavera.config.json`, the declarative list of integrations and artifacts for a project.
- **Apply** (Calavera): the pipeline that writes a recipe into a project; `dry_run_apply` is the approval boundary.
- **`vp`-managed** (Calavera): a project where Vite+ owns the JS and TS toolchain, as detected under CQ2.
- **Baseline target** (both): the I1 value and its resolution by the Calavera engine.
- **Handoff** (both): a named point in `docs/cross-repo/sequencing-map.md` where one project delivers a frozen surface the other consumes.

## I9. Change Log

| Date | Surface | Change | Request |
|---|---|---|---|
| 2026-09-09 | all | initial draft | — |
