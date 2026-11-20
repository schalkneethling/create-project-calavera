---
"create-project-calavera": patch
---

`clean` no longer removes the base Calavera skill in `.agents/skills/calavera` that `--init` installs when the recipe does not select it. The base skill is Calavera's own artifact whatever the recipe selects, so `clean --dry-run` no longer lists it, `clean` keeps it and its record in `.calavera/state.json`, and only `eject` removes it. An artifact that a recipe selected and then dropped is still removed by `clean` when it is unedited (#1007).
