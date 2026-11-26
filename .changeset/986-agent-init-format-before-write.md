---
"create-project-calavera": patch
---

`agent-init` now formats `.calavera/state.json` before it copies the Calavera skill files. When the project's formatter cannot format the state, `agent-init` stops with nothing written, instead of leaving the skill files and `.coderabbit.yaml` in the project with no state record.
