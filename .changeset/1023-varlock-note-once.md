---
"create-project-calavera": patch
---

For a recipe with Varlock, the apply summary that `apply --dry-run`, `apply`, and `init --apply` print no longer names `.env.schema` or `.gitignore` twice. When the "Files" group lists either file, the Varlock note under "Notes" points to it there instead of naming it again; a file that "Files" does not list, such as an `.env.schema` the project already has, or both files on a second apply, is still named in the note. The note still says what to review and which `.env` files Varlock recommends committing. The `pointers` field of `apply --json` and of the MCP `dry_run_apply` and `apply_recipe` results keeps the full note, file names included (#1023).
