---
"create-project-calavera": major
"@schalkneethling/calavera-skill-calavera": patch
---

Remove the Oxfmt integration (`oxfmt`). Calavera no longer adds `format` and `format:check` scripts that run Oxfmt and no longer rejects a recipe for selecting both Oxfmt and Prettier, since only Prettier remains until its own removal; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names `oxfmt` now fails validation as an unknown id: on a Vite+ project, remove the id and rely on `vp fmt` and `vp check`; a project that has not adopted Vite+ runs `vp create` or `vp migrate` first, since Calavera no longer provides a formatter to any project. The Calavera skill no longer describes Oxfmt as an option. See [ADR-0003](../docs/adr/0003-remove-oxfmt.md) and the catalog audit for the evidence.
