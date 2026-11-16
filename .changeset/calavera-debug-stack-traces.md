---
"create-project-calavera": minor
---

Setting the `CALAVERA_DEBUG` environment variable to `1` or `true` now adds the stack frames of each error in the chain to the CLI's error output and, as a `stack` field, to the MCP server's tool error results. The frames are redacted like the messages. Without the variable, the output is unchanged.
