---
"create-project-calavera": patch
---

On macOS and Linux, the commands Calavera prints for you to paste, such as the install command, the command that removes a dev dependency, and the version notice's update command, now quote an argument that starts with `=` or holds `==` or `:=`, as the other printed commands have since #1037, so zsh pastes them unchanged. Windows keeps its own quoting. `apply --config` and `update --config` now handle a recipe whose file name starts with `..`, such as `..recipe.json`, as a recipe from outside the project, so they copy it into the project as `calavera.config.json`, with the same dry-run listing and hard stops. This follows from Calavera now using one rule for whether a path lies inside a folder (#1026).
