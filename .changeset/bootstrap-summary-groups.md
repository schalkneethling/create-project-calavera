---
"create-project-calavera": patch
---

The summary that `--new` and `--init` print now lists each written, updated, or skipped file once under "Changes", then "Notes", then the agent prompt on its own line between blank lines so it can be copied whole, then "Next steps". The `pointers` field of `--init --json` no longer repeats the guidance and MCP files that `changes` already lists; it keeps the skills pointer and adds a pointer only when the guidance needs a manual merge or MCP needs manual setup (#601).
