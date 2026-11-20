---
"create-project-calavera": patch
---

`clean` no longer removes the base Calavera skill that `--init` installs in `.agents/skills/calavera` when the recipe does not select it. The base skill is Calavera's own artifact whatever the recipe selects, so `clean --dry-run` no longer lists it, and `clean` keeps it and its record in `.calavera/state.json`, whether `--init` or a recipe installed it. Only `eject` removes it. Every other artifact that a recipe selected and then dropped is still removed by `clean` when it is unedited (#1007).
