---
"create-project-calavera": patch
---

`--init` now recognizes the `.agents/calavera/mcp.md` that 6.2.0 and 6.2.1 wrote as earlier Calavera text instead of a local edit, so a later template change can update it. That file pins the version that wrote it, and the earlier-guidance table did not list those two releases (#935).
