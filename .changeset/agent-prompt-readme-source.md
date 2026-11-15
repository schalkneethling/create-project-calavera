---
"create-project-calavera": patch
---

The agent prompt that `--new` and `--init` print, and the `nextPrompt` field of `--init --json`, now match the README's agent prompt, which asks the agent to validate and explain the recipe before showing the dry-run result. A test fails when the CLI and the README differ (#840).
