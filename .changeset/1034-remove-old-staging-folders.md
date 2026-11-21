---
"create-project-calavera": patch
---

Apply now removes a `.calavera/.staging/<id>` folder that 6.2.1 or an earlier release left after restoring a locked artifact package, but only when the folder holds exactly the package the lock records for `<id>`. Apply rebuilds that package from the artifact cache to compare them. Every other entry in `.calavera/.staging/`, such as an edited folder, a folder no lock entry names, or a symbolic link, is kept and reported with the reason. `apply --dry-run`, `apply`, and the MCP `dry_run_apply` and `apply_recipe` tools list each entry under Files and in the new `stagingLeftovers` field of the result. Apply checks each folder again just before it removes it, and a removal that fails is reported without stopping apply (#1034).
