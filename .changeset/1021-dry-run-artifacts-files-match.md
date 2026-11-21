---
"create-project-calavera": patch
---

Each entry of `autoInstalledArtifacts` in the `apply --json` result, and in the MCP `dry_run_apply` and `apply_recipe` results, now has a `filesAlreadyMatch` field (#1021). It is `true` when the files in the project already match the version apply locks, so apply writes none of that artifact's files and only records the lock entry. The `dry_run_apply` tool now declares an output schema that describes the field. The lock file that apply writes does not change.
