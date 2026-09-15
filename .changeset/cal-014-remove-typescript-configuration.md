---
"create-project-calavera": major
"@schalkneethling/calavera-skill-calavera": patch
---

Remove the TypeScript configuration integration (`typescript`). Calavera no longer writes `tsconfig.json`, no longer installs `typescript` and `@types/node` for that entry, and no longer adds a `typecheck` script; the recipe's `scripts.typecheck` option is removed from the configuration schema because it had no other subject. On a Vite+ project, `vp create` writes `tsconfig.json` and `vp check` type-checks through tsgolint. A `calavera.config.json` that names `typescript` or sets `scripts.typecheck` now fails validation: remove them and rely on `vp check`. Entries that depend on the TypeScript package, such as `typescript-eslint` until its own removal, keep installing it themselves. The Calavera skill no longer lists `tsconfig.json` among the files to inspect. See [ADR-0004](../docs/adr/0004-remove-typescript-configuration.md) and the catalog audit for the evidence.
