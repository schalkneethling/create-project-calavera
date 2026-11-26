---
"create-project-calavera": patch
---

`artifacts install` and `artifacts update` now write the `aiArtifacts` records in `.calavera/state.json` in the order apply writes them: the artifacts they install first, then every other earlier record, such as the record of an artifact the recipe no longer selects, in its earlier order. Before, they wrote the installed artifacts last, so a run that changed nothing still reordered the state and left it modified in `git status` (#1139).
