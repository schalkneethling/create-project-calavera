---
"create-project-calavera": patch
---

In a Vite+ project, `apply`, `agent-init`, `clean`, and `artifacts install` and `update` now write `.calavera/state.json` and `.calavera/artifacts.lock.json` formatted by the project's own `vp fmt`, like the other JSON files Calavera generates. The Vite+ pre-commit hook no longer rewrites them in the next commit. A Vite+ project whose vite-plus package is not installed now stops the dry run and apply before anything is written, even when no other file needs the formatter (#838).
