# create-project-calavera

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
