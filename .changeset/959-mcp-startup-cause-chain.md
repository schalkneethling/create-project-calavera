---
"create-project-calavera": patch
---

When the MCP server fails to start, it now prints the error and each cause under it, redacted, in the same format as the CLI, instead of only the stack of the top-level error. The stack frames of each error are printed only when the `CALAVERA_DEBUG` environment variable is set to `1` or `true` (#959).
