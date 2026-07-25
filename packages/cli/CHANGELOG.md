# create-project-calavera

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
