---
"create-project-calavera": patch
"@schalkneethling/calavera-skill-calavera": patch
---

Apply now removes a `.calavera/.staging/<id>` folder that 6.2.1 or an earlier release left after restoring a locked artifact package, but only when the folder holds exactly the package the lock records for `<id>`. Apply rebuilds that package from the artifact cache to compare them. Every other entry in `.calavera/.staging/`, such as an edited folder, a folder no lock entry names, or a symbolic link, is kept and reported with the reason. `apply --dry-run` and `apply` list each entry under Files, and the `--json` result and the MCP `dry_run_apply` and `apply_recipe` tools carry it in the new `stagingLeftovers` field. Apply checks each folder again just before it removes it. A folder it cannot read or remove is reported without stopping apply. The base Calavera skill now asks agents to show `stagingLeftovers` with the rest of the dry run (#1034).
