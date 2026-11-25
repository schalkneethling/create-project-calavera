---
"create-project-calavera": patch
---

The `apply --dry-run`, `apply`, and `init --apply` summaries name `.claude/settings.json` once when several artifacts change it. The first artifact that changes the file names it, and each later artifact refers to "the Claude Code settings file listed above", with its own hook groups under its own line, so each artifact's part of the file stays with that artifact. The `--json` and MCP results still report one wiring change for each artifact (#1145).
