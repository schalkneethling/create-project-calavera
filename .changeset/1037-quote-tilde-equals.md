---
"create-project-calavera": patch
---

Commands that Calavera prints for people to paste now quote a token that starts with `~` or `=`, or that holds `~`, `^`, `==`, or `:=`, so zsh and bash run them as printed instead of expanding the token to a home directory, a command path, or a glob pattern (#1037).
