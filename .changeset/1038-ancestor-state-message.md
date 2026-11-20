---
"create-project-calavera": patch
---

When `apply --manifest-choice apply-at-ancestor` stops because the ancestor's directory holds only `.calavera/state.json`, the message now names the state file, says that Calavera has already recorded state there, and suggests running apply there with a recipe for that directory, instead of claiming that the directory has a Calavera recipe of its own. The bootstrap that `--init` runs writes that state file without a recipe. Apply still stops before writing anything (#1038).
