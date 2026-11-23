---
"create-project-calavera": patch
---

`apply` now refuses to write artifacts through a symbolic link when every artifact the recipe selects is already locked, as `artifacts install` and `artifacts update` refuse since #1193. A linked `.agents`, `.agents/skills`, `.agents/hooks`, `.agents/agents`, `.codex`, `.calavera`, `.calavera/packages`, or `.calavera/.transactions` folder stops `apply` and `apply --dry-run` before Calavera rebuilds a missing package or writes any artifact file, with a message that names the link and tells you to replace it with a real folder. `apply` that installs an unlocked artifact also checks the folders of the artifacts that are already locked. `artifacts status --check-updates` now refuses a linked `.calavera` even when the artifact cache block is already recorded, because the update check fills the registry cache in `.calavera/cache` (#1209).
