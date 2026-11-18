---
"create-project-calavera": patch
---

When `--new` or `--init` leaves MCP to manual setup, or asks you to merge `AGENTS.calavera.md` into an existing `AGENTS.md`, the note that tells you what to do by hand now points to the file listed under "Changes" instead of naming `.agents/calavera/mcp.md` or `AGENTS.calavera.md` a second time. The same text appears in the `mcp.reason` and `pointers` fields of `--init --json` (#1020).
