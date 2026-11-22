---
"create-project-calavera": patch
---

`applyRecipeObject` with the `apply-at-ancestor` manifest choice no longer stops on a `config` path outside the current directory. Such a path does not move to the ancestor's directory, so a file there is not a recipe the ancestor already has. A path that reaches the current directory through a directory link counts as inside, so it moves and is checked like any other path inside. The ancestor's own `calavera.config.json` and `.calavera/state.json` still stop the apply, and the refusal names only files inside the ancestor's directory (#1142).
