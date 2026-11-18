---
"create-project-calavera": patch
---

`artifacts migrate` now writes `calavera.config.json` through the project's formatter, as `apply` writes it, so the Vite+ pre-commit hook no longer rewrites the migrated recipe. A dry run formats the recipe too, so a formatter that cannot format it stops the dry run and the migration before either writes anything (#987).
