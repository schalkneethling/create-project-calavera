---
"create-project-calavera": patch
---

`apply` now rebuilds a locked artifact package that is missing from `.calavera/packages/` in a temporary folder outside the project, and copies it into place only after the state is formatted, as the first write `apply` makes after it installs unlocked artifacts. An `apply` that stops while it plans, for example because the project's formatter cannot format `.calavera/state.json`, no longer restores the package. `apply` also no longer leaves an untracked `.calavera/.staging/` folder behind after a successful or a failed run, and `apply --dry-run` now removes the temporary folders it rebuilds locked packages in. When removing one of those temporary folders fails, `apply` still removes the others, and it reports each failure together with the error that stopped it, instead of in its place.
