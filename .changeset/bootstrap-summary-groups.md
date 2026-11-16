---
"create-project-calavera": patch
---

The summary that `--new` and `--init` print now lists each written, updated, or skipped file once under "Changes" (the Calavera skill and `.coderabbit.yaml` are still left out when they are already up to date), then "Notes", then the agent prompt on its own line between blank lines so it can be copied whole, then "Next steps". The `pointers` field of `--init --json` no longer repeats the guidance and MCP files that `changes` already lists; it keeps the skills pointer and adds a pointer only when `AGENTS.calavera.md` holds Calavera's current guidance and still needs a manual merge, including on a rerun before that merge, or MCP needs manual setup. A failed MCP config write no longer ends its sentence with two periods (#601).
