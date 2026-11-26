---
"create-project-calavera": patch
---

`artifacts doctor` no longer fails on a lock entry the recipe no longer selects whose files were deleted, because the entry is a leftover record. `artifacts status` and `artifacts doctor` print the entry as a warning with the `artifacts install` command, which drops it when it can also install what the recipe selects, and `ok` stays `true` in `--json` output and in the MCP `artifact_status` tool, whose entry carries that command in `installCommand`. A selected artifact whose files were deleted still fails `artifacts doctor` (#1111).
