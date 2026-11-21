---
"create-project-calavera": patch
---

Interactive `--init` (`agent-init`) now asks how to add guidance to an existing `AGENTS.md` and which agent harness to configure before it writes any file. Cancelling at either prompt now leaves the project unchanged. Before, the Calavera skill and `.coderabbit.yaml` were already copied, and `AGENTS.md` already changed, when the harness prompt appeared, so a cancel left them in place with no record in `.calavera/state.json` (#1039).
