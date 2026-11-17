---
"create-project-calavera": patch
---

After `--new`, the next steps now start with `cd` into the scaffolded project, and they print before the agent prompt, so the prompt is read as a step to use once the project is open in the agent. The `cd` no longer sits inside the Composer option, so `apply --dry-run` and `apply` stay where they belong: in the block for a project that has `calavera.config.json`, or after the Composer step that saves one. `--init` prints the same block without the `cd` step (#602).
