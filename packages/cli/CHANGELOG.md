# create-project-calavera

## 3.0.0

### Major Changes

- 3679738: Remove the Oxlint integration and its fourteen plugin pack entries (`oxlint`, `oxlint-eslint`, `oxlint-typescript`, `oxlint-unicorn`, `oxlint-oxc`, `oxlint-import`, `oxlint-react`, `oxlint-jsx-a11y`, `oxlint-node`, `oxlint-promise`, `oxlint-vitest`, `oxlint-jest`, `oxlint-nextjs`, `oxlint-vue`, `oxlint-jsdoc`). Calavera no longer writes `oxlint.json` or adds `oxlint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp lint`. The Calavera skill no longer lists `oxlint.json` among the files to inspect. See [ADR-0002](../docs/adr/0002-remove-oxlint.md) and the catalog audit for the evidence.
- 12d4226: Remove the Oxfmt integration (`oxfmt`). Calavera no longer adds `format` and `format:check` scripts that run Oxfmt and no longer rejects a recipe for selecting both Oxfmt and Prettier, since only Prettier remains until its own removal; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names `oxfmt` now fails validation as an unknown id: on a Vite+ project, remove the id and rely on `vp fmt` and `vp check`; a project that has not adopted Vite+ and uses the Classic profile keeps Prettier until CAL-016 removes it. Once CAL-016 lands, Calavera provides no formatter to any project, and a project without Vite+ runs `vp create` or `vp migrate` first. The Calavera skill no longer describes Oxfmt as an option. See [ADR-0003](../docs/adr/0003-remove-oxfmt.md) and the catalog audit for the evidence.
- 4ae0d07: Remove the TypeScript configuration integration (`typescript`). Calavera no longer writes `tsconfig.json`, no longer installs `typescript` and `@types/node` for that entry, and no longer adds a `typecheck` script; the recipe's `scripts.typecheck` option is removed from the configuration schema because it had no other subject. On a Vite+ project, `vp create` writes `tsconfig.json` and `vp check` type-checks through tsgolint. A `calavera.config.json` that names `typescript` now fails validation as an unknown id; one that still sets `scripts.typecheck` validates but the flag is ignored and no `typecheck` script is generated. Remove both and rely on `vp check`. Entries that depend on the TypeScript package, such as `typescript-eslint` until its own removal, keep installing it themselves. The Calavera skill no longer lists `tsconfig.json` among the files to inspect. See [ADR-0004](../docs/adr/0004-remove-typescript-configuration.md) and the catalog audit for the evidence.
- aa1545c: Remove the JavaScript and TypeScript ESLint flat config integration (`eslint`) and the eleven entries that include it (`typescript-eslint`, `eslint-config-prettier`, `eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`). Calavera no longer writes `eslint.config.js` or adds `eslint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. Nine of the removed plugin entries (`eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`) installed a dependency but never entered the generated configuration; projects that selected them can remove that dependency. A `calavera.config.json` that names any removed id now fails validation as an unknown id. This removal is the JavaScript ESLint host only; the CSS lint host css-evolve needs (`@eslint/css`) is unaffected. See [ADR-0005](../docs/adr/0005-remove-eslint-flat-config.md) and the catalog audit for the evidence.
- 4264b1c: Remove the Prettier integration (`prettier`) and the entries that include it (`prettier-tailwind`, `prettier-svelte`, `prettier-astro`). Calavera no longer writes `.prettierrc.json` or `.prettierignore` and no longer adds `format` or `format:check` scripts for any project; the recipe's `scripts.format` and `scripts.format:check` options are removed from the configuration schema because no integration can satisfy them, and a recipe that still sets them validates but produces no script; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp fmt`. With this change the Modern and Classic profiles have identical defaults; their collapse is decided separately. See [ADR-0006](../docs/adr/0006-remove-prettier.md) and the catalog audit for the evidence.

## 2.6.0

### Minor Changes

- 3cb9785: `inspect_project` now reports whether the project is managed by Vite+ through an optional `vitePlus` field and four new finding kinds (`vite-plus-managed`, `vite-plus-unmanaged`, `vite-plus-signal-conflict`, `vite-plus-detection-unknown`). The change is additive, with nothing changed or removed; see [ADR-0001](../docs/adr/0001-vite-plus-detection-signal.md) for the detection signal and its rationale.

## 2.5.0

### Minor Changes

- 499016c: Add an optional GitHub repository-controls integration that generates managed desired-state,
  Dependabot, audit/apply script, and documentation files without mutating GitHub during Calavera
  apply.
- dc6be3d: Extend GitHub repository controls with CodeQL merge protection and default newly generated policies to the extended query suite. Verify branch scope and bypass protections, preserve unrelated rules and scanners during updates, and retain read-only checks and explicit apply with read-back verification.

### Patch Changes

- 9386307: Isolate independently versioned skills, hooks, and agents from the CLI runtime dependency graph while preserving explicit locked artifact installation and updates.
- ad107fd: Apply upstream review corrections to frontend, publishing, and agent artifacts, and exclude installed Calavera package and Claude agent payloads from downstream CodeRabbit reviews.
- Updated dependencies [9386307]
  - @schalkneethling/calavera-artifact-core@0.4.0

## 2.4.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [d65cb63]
- Updated dependencies [5d620bc]
  - @schalkneethling/calavera-artifact-core@0.3.0

## 2.4.0-next.1

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [5d620bc]
  - @schalkneethling/calavera-artifact-core@0.3.0-next.1

## 2.4.0-next.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- Updated dependencies [d65cb63]
  - @schalkneethling/calavera-artifact-core@0.3.0-next.0

## 2.3.0

### Minor Changes

- c0ad502: Add merge-safe CodeRabbit path exclusions whenever Calavera installs skill artifacts.
- e5151e0: Add optional Knip unused-code analysis with managed configuration and quality script integration.
- dcdade0: Add the shared Baseline recommendation engine and carry configurable Stylelint Baseline targets through recipes, generated configuration, CLI, and MCP tools.
- cae2686: Add optional HTML validation with managed HTML Validate configuration, ignores, scripts, and cross-surface catalog support.
- Add the Varlock environment schema and validation integration, contributed by Theo Ephraim in #127.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- 9dff8ff: Report planned deletions and locally edited skips in human-readable clean output.
- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- 4a4e91c: Expose minimum CLI versions for integrations so the hosted Composer can avoid unreleased CLI capabilities.
- Updated dependencies [76d85ef]
- Updated dependencies [e3e46a7]
- Updated dependencies [d525776]
- Updated dependencies [32b3315]
- Updated dependencies [71d46d1]
- Updated dependencies [dcdade0]
- Updated dependencies [dd70f1e]
- Updated dependencies [6ae1222]
  - @schalkneethling/calavera-baseline-core@0.2.0
  - @schalkneethling/calavera-artifact-core@0.2.0

## 2.3.0-next.3

### Patch Changes

- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- Updated dependencies [e3e46a7]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.3
  - @schalkneethling/calavera-artifact-core@0.2.0-next.3

## 2.3.0-next.2

### Patch Changes

- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- Updated dependencies [71d46d1]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.2
  - @schalkneethling/calavera-artifact-core@0.2.0-next.2

## 2.3.0-next.1

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- Updated dependencies [76d85ef]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.1
  - @schalkneethling/calavera-artifact-core@0.2.0-next.1

## 2.3.0-next.0

### Minor Changes

- c0ad502: Add merge-safe CodeRabbit path exclusions whenever Calavera installs skill artifacts.
- e5151e0: Add optional Knip unused-code analysis with managed configuration and quality script integration.
- dcdade0: Add the shared Baseline recommendation engine and carry configurable Stylelint Baseline targets through recipes, generated configuration, CLI, and MCP tools.
- cae2686: Add optional HTML validation with managed HTML Validate configuration, ignores, scripts, and cross-surface catalog support.
- Add the Varlock environment schema and validation integration, contributed by Theo Ephraim in #127.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- 9dff8ff: Report planned deletions and locally edited skips in human-readable clean output.
- 4a4e91c: Expose minimum CLI versions for integrations so the hosted Composer can avoid unreleased CLI capabilities.
- Updated dependencies [d525776]
- Updated dependencies [32b3315]
- Updated dependencies [dcdade0]
- Updated dependencies [dd70f1e]
- Updated dependencies [6ae1222]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.0
  - @schalkneethling/calavera-artifact-core@0.2.0-next.0
