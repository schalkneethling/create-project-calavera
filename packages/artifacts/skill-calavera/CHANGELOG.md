# @schalkneethling/calavera-skill-calavera

## 0.2.2

### Patch Changes

- fba4a61: Drop the upper bound from the Calavera compatibility range so the artifact installs on create-project-calavera 3.0.0 and later. Every artifact declared `<3`, and the 3.0.0 CLI rejected all of them at install time while the hosted Composer hid them as waiting for a newer CLI. The lower bound stays: it is what keeps Composer from offering an artifact before a CLI that can install it is published. A change to the manifest contract itself is signaled by `schemaVersion`, not by a CLI major. The artifact catalog in `@schalkneethling/calavera-artifact-core` carries the same ranges and changes with them.

## 0.2.1

### Patch Changes

- 3679738: Remove the Oxlint integration and its fourteen plugin pack entries (`oxlint`, `oxlint-eslint`, `oxlint-typescript`, `oxlint-unicorn`, `oxlint-oxc`, `oxlint-import`, `oxlint-react`, `oxlint-jsx-a11y`, `oxlint-node`, `oxlint-promise`, `oxlint-vitest`, `oxlint-jest`, `oxlint-nextjs`, `oxlint-vue`, `oxlint-jsdoc`). Calavera no longer writes `oxlint.json` or adds `oxlint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp lint`. The Calavera skill no longer lists `oxlint.json` among the files to inspect. See [ADR-0002](../docs/adr/0002-remove-oxlint.md) and the catalog audit for the evidence.
- 12d4226: Remove the Oxfmt integration (`oxfmt`). Calavera no longer adds `format` and `format:check` scripts that run Oxfmt and no longer rejects a recipe for selecting both Oxfmt and Prettier, since only Prettier remains until its own removal; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names `oxfmt` now fails validation as an unknown id: on a Vite+ project, remove the id and rely on `vp fmt` and `vp check`; a project that has not adopted Vite+ and uses the Classic profile keeps Prettier until CAL-016 removes it. Once CAL-016 lands, Calavera provides no formatter to any project, and a project without Vite+ runs `vp create` or `vp migrate` first. The Calavera skill no longer describes Oxfmt as an option. See [ADR-0003](../docs/adr/0003-remove-oxfmt.md) and the catalog audit for the evidence.
- 4ae0d07: Remove the TypeScript configuration integration (`typescript`). Calavera no longer writes `tsconfig.json`, no longer installs `typescript` and `@types/node` for that entry, and no longer adds a `typecheck` script; the recipe's `scripts.typecheck` option is removed from the configuration schema because it had no other subject. On a Vite+ project, `vp create` writes `tsconfig.json` and `vp check` type-checks through tsgolint. A `calavera.config.json` that names `typescript` now fails validation as an unknown id; one that still sets `scripts.typecheck` validates but the flag is ignored and no `typecheck` script is generated. Remove both and rely on `vp check`. Entries that depend on the TypeScript package, such as `typescript-eslint` until its own removal, keep installing it themselves. The Calavera skill no longer lists `tsconfig.json` among the files to inspect. See [ADR-0004](../docs/adr/0004-remove-typescript-configuration.md) and the catalog audit for the evidence.
- aa1545c: Remove the JavaScript and TypeScript ESLint flat config integration (`eslint`) and the eleven entries that include it (`typescript-eslint`, `eslint-config-prettier`, `eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`). Calavera no longer writes `eslint.config.js` or adds `eslint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. Nine of the removed plugin entries (`eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`) installed a dependency but never entered the generated configuration; projects that selected them can remove that dependency. A `calavera.config.json` that names any removed id now fails validation as an unknown id. This removal is the JavaScript ESLint host only; the CSS lint host css-evolve needs (`@eslint/css`) is unaffected. See [ADR-0005](../docs/adr/0005-remove-eslint-flat-config.md) and the catalog audit for the evidence.
- 4264b1c: Remove the Prettier integration (`prettier`) and the entries that include it (`prettier-tailwind`, `prettier-svelte`, `prettier-astro`). Calavera no longer writes `.prettierrc.json` or `.prettierignore` and no longer adds `format` or `format:check` scripts for any project; the recipe's `scripts.format` and `scripts.format:check` options are removed from the configuration schema because no integration can satisfy them, and a recipe that still sets them validates but produces no script; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp fmt`. With this change the Modern and Classic profiles have identical defaults; their collapse is decided separately. See [ADR-0006](../docs/adr/0006-remove-prettier.md) and the catalog audit for the evidence.

## 0.2.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.

## 0.2.0-next.3

### Patch Changes

- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.

## 0.2.0-next.2

### Patch Changes

- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.

## 0.2.0-next.1

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.

## 0.2.0-next.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.
