---
"create-project-calavera": minor
---

After a successful `--new`, and after `--init`, the CLI prints the next steps: the project needs a recipe before Calavera changes anything, so the block names both ways to get one, the agent prompt printed above it or the hosted Composer at https://calavera.schalkneethling.com/, with the directory to save `calavera.config.json` into and the preview and apply commands for the project's package manager. After `--new` the commands start with a `cd` into the scaffolded directory; `--init` omits it. When the project already has `calavera.config.json`, the block names that file instead. `--init --json` returns the same lines as a `nextSteps` array and the resolved `packageManager`. The `--new` dry run and every `--new` stop print no block.
