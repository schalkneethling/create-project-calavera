---
"create-project-calavera": patch
---

`--init` now recognizes the `.agents/calavera/mcp.md` that 6.2.0 and 6.2.1 wrote as earlier Calavera text, not a local edit, so a later template change can update it. Those releases pin their own version in that file, which the earlier-guidance table did not list. A test now fails when the version in `package.json` is missing from the table, so a release cannot ship without its entry (#935).
