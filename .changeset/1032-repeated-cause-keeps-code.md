---
"create-project-calavera": patch
---

The structured error that an MCP tool returns keeps the `code` and name of a cause whose message the wrapping error repeats. Before, such a cause was left out entirely, so a wrapped `EBUSY` and a wrapped `ENOENT` with the same wrapper message looked the same. The cause now appears with an empty message, so the message is still shown once. The printed error text is unchanged (#1032).
