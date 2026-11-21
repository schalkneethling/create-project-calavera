---
"create-project-calavera": minor
---

Each entry of `autoInstalledArtifacts` in the `apply --json` result, and in the MCP `dry_run_apply` and `apply_recipe` results, now has a `filesAlreadyMatch` field (#1021). It is `true` when the files in the project already match the version apply locks, so apply writes none of that artifact's files. Apply still locks the version, stores the package under `.calavera/packages/`, and records the artifact in `.calavera/state.json`. The `dry_run_apply` tool now declares an output schema that describes the field. The apply summary reads the same field for its "its files in the project already match" line, so the summary and the JSON result agree. The lock file that apply writes does not change.
