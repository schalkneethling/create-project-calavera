---
"create-project-calavera": patch
---

For a recipe with Varlock, the apply summary that `apply --dry-run`, `apply`, and `init --apply` print now names `.env.schema` and `.gitignore` once, under "Files". The Varlock note under "Notes" points to the schema and ignore file listed there instead of naming them a second time, and still says what to review and which `.env` files Varlock recommends committing. The `pointers` field of `apply --json` and of the MCP `dry_run_apply` and `apply_recipe` results keeps the full note, file names included (#1023).
