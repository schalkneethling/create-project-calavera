---
"create-project-calavera": patch
---

`artifacts migrate` and `artifacts migrate --dry-run` now stop before writing when rewriting the recipe would lose something you wrote: a key that appears twice in one object, where only the last value would be kept, or a number that Calavera would write in another spelling, such as `1.50` written as `1.5`. The error names the recipe file and the line to edit. Before, the migration rewrote the recipe without a warning. A recipe that loses nothing migrates as before. When `eject` keeps an MCP harness entry because its file repeats a key, the reason now names the line of the repeated key too (#1078).
