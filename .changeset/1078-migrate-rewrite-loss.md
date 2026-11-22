---
"create-project-calavera": patch
---

`artifacts migrate` and `artifacts migrate --dry-run` now stop before writing when rewriting the recipe would lose something you wrote: a key that appears twice in one object, where only the last value would be kept, or a number that Calavera would write in another spelling, such as `1.50` written as `1.5`. The error names the recipe file and the line to edit. Before, the migration rewrote the recipe without a warning. A recipe that loses nothing migrates as before. Every report of a repeated key now also names the line where the key appears again: `eject`'s reason for keeping an MCP harness entry, and `apply`'s refusal to rewrite `.claude/settings.json` (#1078).
