---
"create-project-calavera": patch
---

When Calavera cannot remove one of its temporary folders after apply has written the AI outputs, apply now finishes instead of stopping before the config, the `package.json` scripts, and the state are written. The summary names each folder left behind under Notes with the error code and asks you to remove it. The `--json` result and the MCP `dry_run_apply` and `apply_recipe` tools carry the folders in the new `temporaryFolderLeftovers` field, and the dry run reports the same failure the same way. Apply still exits non-zero when something else fails, such as the dependency install, and that message names the folders too. Messages about a failed removal now name the temporary folder and the error code instead of repeating the underlying error's message (#1033).
