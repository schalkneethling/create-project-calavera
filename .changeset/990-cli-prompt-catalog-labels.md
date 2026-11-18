---
"create-project-calavera": patch
---

The `--init` prompts now show the catalog's display labels instead of raw IDs: each integration's hint shows its status label, such as "Framework-specific" instead of `framework-specific`, and each AI artifact's hint names its default target by label, such as "Claude Code". For a hook or agent artifact, the target prompt is now a choice among the targets that artifact supports, listed by label, instead of a free-text directory that recipe validation rejected (#990).
