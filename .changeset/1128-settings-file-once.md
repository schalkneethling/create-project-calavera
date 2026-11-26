---
"create-project-calavera": patch
---

The summary that `apply --dry-run`, `apply`, and `init --apply` print names `.claude/settings.json` on one line, with the hook groups each artifact adds, replaces, or removes listed under that line. The Vite+ hook dispatcher warning points at "the .vite-hooks blocks listed above", and the protected-branch warning points at the branch input listed above, instead of naming the artifact again. The `wiringWarnings` and `wiringChanges` fields of `apply --json` and of the MCP `dry_run_apply` and `apply_recipe` results are unchanged, artifact IDs included (#1128).
