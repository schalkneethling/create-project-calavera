---
"create-project-calavera": patch
---

The structured error chain that the MCP server returns for a failed tool call now keeps each error's `errno` and `syscall`, and keeps a `code` that is a number, such as a process exit code, as its decimal text, so `code` stays a string. `code` and `syscall` are redacted as the message is. `errno` is always a number, and is left out when its decimal form holds a secret. A cause that the chain left out because its wrapper already repeats its message is now also kept when it carries only an `errno` or a `syscall`, so that `EBUSY` on `rename` and `EBUSY` on `open` stay distinguishable. The text that the CLI prints is unchanged (#1150).
