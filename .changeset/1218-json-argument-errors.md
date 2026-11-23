---
"create-project-calavera": patch
---

With `--json`, a run whose own arguments are invalid now prints a JSON result instead of plain text. An unknown flag, a flag missing its value, a flag value outside its allowed values, or an unknown command prints `{ command, ok: false, issues }` on standard output, with the error as an issue with the level `error`, and exits 1 as before. `command` is the name that the command's success result uses, as the #1227 entry describes, such as `init` when the arguments name no command. The message is the same text that the run prints without `--json`, which is unchanged (#1218).
