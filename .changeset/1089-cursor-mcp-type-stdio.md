---
"create-project-calavera": patch
---

`--init` now writes the `calavera` entry in `.cursor/mcp.json` with `"type": "stdio"`, which Cursor's documentation lists as required for a local server, and `.agents/calavera/mcp.md` shows the same shape (#1089). Rerunning `--init` adds `type` to the entry an earlier release wrote. `.mcp.json` for Claude Code and `opencode.json` do not change. `eject` recognizes the Cursor entry that 6.2.1 and earlier releases wrote, without `type`, as unedited, as well as the new one, and `--init` still recognizes the `.agents/calavera/mcp.md` that earlier releases wrote as earlier Calavera text.
