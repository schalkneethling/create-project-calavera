---
"create-project-calavera": major
"@schalkneethling/calavera-skill-calavera": patch
---

Remove the Prettier integration (`prettier`) and the entries that include it (`prettier-tailwind`, `prettier-svelte`, `prettier-astro`). Calavera no longer writes `.prettierrc.json` or `.prettierignore` and no longer adds `format` or `format:check` scripts for any project; the recipe's `scripts.format` and `scripts.format:check` options are removed from the configuration schema because no integration can satisfy them, and a recipe that still sets them validates but produces no script; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp fmt`. With this change the Modern and Classic profiles have identical defaults; their collapse is decided separately. See [ADR-0006](../docs/adr/0006-remove-prettier.md) and the catalog audit for the evidence.
