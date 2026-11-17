---
"create-project-calavera": patch
---

In a Vite+ project, `apply`, `agent-init`, `clean`, and `artifacts install` and `update` now write `.calavera/state.json` and `.calavera/artifacts.lock.json` formatted by the project's own `vp fmt`, like the other JSON files Calavera generates. The Vite+ pre-commit hook no longer rewrites them in the next commit. The state and the lock are formatted before anything is written, in the dry run as well, so a Vite+ project whose formatter cannot run now stops `apply`, `clean`, and `artifacts install` and `update`, and their dry runs, before they change anything, even when no other file needs the formatter (#838). When the recipe no longer includes `editorconfig` and removing Calavera's `.editorconfig` would change how `vp fmt` formats the state, `clean` stops before changing anything and says to delete `.editorconfig` first.
