---
"create-project-calavera": patch
---

When `apply --manifest-choice apply-at-ancestor` stops because the ancestor's directory holds only `.calavera/state.json`, the message now names the state file and says that Calavera has already recorded state there, instead of claiming that the directory has a Calavera recipe of its own. The bootstrap and the `artifacts` commands write that state file without a recipe. Apply still stops before writing anything (#1038).
