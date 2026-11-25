---
"create-project-calavera": patch
---

The `apply --dry-run`, `apply`, and `init --apply` summaries name `.claude/settings.json` once, on one line under Artifacts after the artifacts, with every artifact's hook groups under it. Each group line names its artifact, in the words the `clean` summary uses, such as "Would remove the Stop group for skill-a, because the recipe no longer selects skill-a". A settings file that already holds an artifact's groups is named as unchanged, with "Already holds the hook groups for" that artifact under it. Before, the file was named again under each artifact that changed it. The `--json` and MCP results still report one wiring change for each artifact (#1145).
