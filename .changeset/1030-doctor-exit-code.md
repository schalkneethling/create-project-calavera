---
"create-project-calavera": patch
---

`doctor` now exits with status 1 when it reports an error, such as a missing `calavera.config.json`, in both text and `--json` output, so a CI step that runs `doctor` fails instead of passing. When `doctor` reports only warnings, or no issues, it still exits 0 (#1030).
