---
"create-project-calavera": patch
---

`apply` now rebuilds a locked artifact package that is missing from `.calavera/packages/` in a temporary folder outside the project, and copies it into place only after every check that can stop `apply` has passed, so a stopped `apply` no longer restores the package. `apply` also no longer leaves an untracked `.calavera/.staging/` folder behind, after a successful or a failed run.
