---
"create-project-calavera": patch
---

`applyRecipeObject` with the `apply-at-ancestor` manifest choice no longer stops on a `config` path outside the current directory. Such a path does not move to the ancestor's directory, so it names the recipe being applied, not a recipe the ancestor already has. The ancestor's own `calavera.config.json` and `.calavera/state.json` still stop the apply, and the refusal names only files inside the ancestor's directory (#1142).
