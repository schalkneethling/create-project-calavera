---
"create-project-calavera": patch
---

`apply`, `apply --dry-run`, and the MCP `dry_run_apply` and `apply_recipe` tools now refuse, before writing anything, a legacy AI entry that selects an artifact that needs wiring or inputs, such as `{ "type": "skill", "src": "skills/protected-branch-guard" }`. The error names the entry and tells you to run `artifacts migrate`, which rewrites legacy entries as ID entries. Before, `apply` never wired the artifact such an entry selects, and when a recipe switched from the ID entry to the legacy entry, `apply` removed the artifact's `.vite-hooks` and `.claude/settings.json` wiring and its record. A legacy entry for an artifact with no wiring or inputs still applies as before (#1125).
