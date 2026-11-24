---
"create-project-calavera": patch
---

`--init`, `agent-init`, and `bootstrap` now refuse to write through a symbolic link, as `artifacts install`, `artifacts update`, and `apply` refuse since #1193 and #1209. A linked `.agents`, `.agents/skills`, `.agents/skills/calavera`, `.agents/calavera`, or `.calavera` folder stops the bootstrap, and its dry run, before it writes the base skill, `AGENTS.md`, the MCP setup, or `.calavera/state.json`, with the same message, which names the link and tells you to replace it with a real folder. Before this change, a linked `.agents`, `.agents/skills`, `.agents/calavera`, or `.calavera` let the bootstrap copy the base skill, or write its MCP setup notes or state, into the folder the link points to, outside the project; a linked `.agents/skills/calavera` was already refused, with a message that called the skill not Calavera-managed. `--new` runs the same bootstrap, so it stops the same way after Vite+ scaffolds the project (#1231).
