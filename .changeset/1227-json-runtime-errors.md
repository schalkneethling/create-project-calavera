---
"create-project-calavera": patch
---

With `--json`, a command that stops with an error while it runs now prints a JSON result instead of plain text, as a run whose arguments are invalid already does. For example, `apply --json --config missing.json` or `artifacts bogus --json` prints `{ command, ok: false, issues }` on standard output, with the error as an issue with the level `error`, and exits 1 as before. The message is the same redacted text that the run prints without `--json`, which is unchanged (#1227).
