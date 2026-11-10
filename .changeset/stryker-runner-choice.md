---
"create-project-calavera": minor
---

An interactive `apply` and `init` now ask which test runner Stryker uses when the recipe selects `stryker` and records no `integrationOptions.stryker.testRunner` (#890). The choices come from the integration's `testRunners` in the catalog, with Vitest preselected, so pressing Enter keeps the default and records nothing. When you choose `node:test`, `apply` also asks which paths the project's test script passes to `node --test`; an empty answer keeps the files that `node --test` runs by default and records no `testFiles`. Both record your answer in `calavera.config.json`, and the dry run names the runner you chose. A run with `--yes` or `--json`, or without a terminal, never asks and keeps Vitest. The Composer shows a test runner control when `stryker` is selected, and the Calavera skill that `--init` installs tells the agent to confirm the runner with the user.
