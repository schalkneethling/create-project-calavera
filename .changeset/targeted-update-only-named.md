---
"create-project-calavera": minor
---

A targeted `artifacts update <id>` no longer installs and locks the selections that have no lock entry. Before, it installed and locked each of them on the channel that its `--tag` named. It still advances only the artifact it names and keeps every other locked selection at its locked version. Selections without a lock entry now stay as they are until `artifacts install` or `artifacts update --all` installs them. When `artifacts status --check-updates` finds an update and the recipe has such selections, it says so after the update commands, in place of the list of selections that an update also installed, and `--json` no longer returns `updateAlsoInstalls`. Local edits still stop an update (#991).
