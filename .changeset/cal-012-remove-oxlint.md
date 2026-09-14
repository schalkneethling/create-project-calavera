---
"create-project-calavera": major
"@schalkneethling/calavera-skill-calavera": patch
---

Remove the Oxlint integration and its fourteen plugin pack entries (`oxlint`, `oxlint-eslint`, `oxlint-typescript`, `oxlint-unicorn`, `oxlint-oxc`, `oxlint-import`, `oxlint-react`, `oxlint-jsx-a11y`, `oxlint-node`, `oxlint-promise`, `oxlint-vitest`, `oxlint-jest`, `oxlint-nextjs`, `oxlint-vue`, `oxlint-jsdoc`). Calavera no longer writes `oxlint.json` or adds `oxlint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp lint`. The Calavera skill no longer lists `oxlint.json` among the files to inspect. See [ADR-0002](../docs/adr/0002-remove-oxlint.md) and the catalog audit for the evidence.
