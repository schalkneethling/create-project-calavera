---
"create-project-calavera": patch
---

`artifacts doctor` no longer fails on a lock entry the recipe no longer selects whose files were deleted, because only the record is left. `artifacts status` and `artifacts doctor` print the entry as a warning with the `artifacts install` command, which drops it, and `ok` stays `true` in `--json` output and in the MCP `artifact_status` tool, whose entry carries that command in `installCommand`. A selected artifact whose files were deleted still fails `artifacts doctor` (#1111).
