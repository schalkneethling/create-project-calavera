---
"create-project-calavera": patch
---

After `--new` and `--init`, the next steps now print before the agent prompt, so the prompt is read as a step to use once the project is open in the agent, and a blank line follows the prompt. After `--new`, the first step is the `cd` into the scaffolded project; it no longer sits inside the Composer option. `--init` prints the same block without the `cd` step. As before, `apply --dry-run` and `apply` appear only for a project that has `calavera.config.json`, or after the Composer step that saves one (#602).
