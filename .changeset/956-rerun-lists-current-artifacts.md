---
"create-project-calavera": patch
---

A second run of `--init` or `apply` now names every AI artifact output and `.coderabbit.yaml` that is already up to date, instead of leaving them out. The bootstrap summary lists them under "Changes" as skipped, for example `Skipped .agents/skills/calavera: Already up to date.`, and the `apply` summary lists `.coderabbit.yaml` under "Files" and each artifact under "Artifacts" as unchanged, with its destination. The `changes` field of the `--json` and MCP results carries the same entries, with `type: "skip"` from the bootstrap and `type: "unchanged"` from `apply`. An updated `.coderabbit.yaml` in the bootstrap summary no longer ends with ": undefined" (#956).
