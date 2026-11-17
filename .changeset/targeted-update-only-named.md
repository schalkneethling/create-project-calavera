---
"create-project-calavera": minor
---

A targeted `artifacts update <id>` now installs and locks only the artifact it names. Before, it also installed and locked every selection without a lock entry, on the channel that its `--tag` named. Such selections now stay as they are until `artifacts install` or `artifacts update --all` installs them, and `artifacts status --check-updates` says so after the update commands. Local edits to the updated artifact still stop the update (#991).
