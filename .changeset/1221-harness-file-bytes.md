---
"create-project-calavera": patch
---

When `--init` adds Calavera's MCP entry to `.mcp.json`, `.cursor/mcp.json`, or `opencode.json`, updates the entry an earlier release wrote, or moves OpenCode's entry from `mcp` to `mcp.servers`, it now changes only that entry. The rest of the file keeps its indentation, line endings, byte order mark, and key order, where `--init` used to rewrite the whole file with two-space indentation and LF line endings, and moved integer-like keys such as `"1"` ahead of the others. In a Vite+ project, a file that already passes `vp fmt` is formatted again after the edit, so `vp check` still passes; a file that `vp fmt` would change keeps the person's bytes, with only the entry edited. A harness file that opens with a byte order mark is now updated instead of falling back to manual setup. An entry that is already up to date is left as it is, whatever the file's formatting (#1221).
