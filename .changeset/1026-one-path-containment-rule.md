---
"create-project-calavera": patch
---

On macOS and Linux, the commands Calavera prints for you to paste, such as the install command, the command that removes a dev dependency, and the version notice's update command, now quote an argument that starts with `=` or holds `==` or `:=`, as the other printed commands have since #1037, so zsh pastes them unchanged. Windows keeps its own quoting. Calavera now uses one rule for whether a path lies inside a folder (#1026).
