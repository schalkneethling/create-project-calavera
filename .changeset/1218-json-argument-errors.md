---
"create-project-calavera": patch
---

With `--json`, a run whose own arguments are invalid now prints a JSON result instead of plain text. An unknown flag, a flag missing its value, a flag value outside its allowed values, or an unknown command prints `{ command, ok: false, issues }` on standard output, with the error as an issue with the level `error`, and exits 1 as before. `command` names the command the run would have run, such as `init` when the arguments name none, or is `null` when that is not a command Calavera has. The message is the same text that the run prints without `--json`, which is unchanged (#1218).
