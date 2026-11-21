---
"create-project-calavera": patch
---

A second run of `--init` or `apply` now names every AI artifact output and `.coderabbit.yaml` that is already up to date, instead of leaving them out (#956).

- The bootstrap summary that `--init` and `--new` print lists them under "Changes" as skipped, for example `Skipped .agents/skills/calavera: Already up to date.` The `changes` field of `--init --json` and the `bootstrap.changes` field of `--new --json` carry them with `type: "skip"`.
- The `apply` summary lists `.coderabbit.yaml` under "Files" as `Unchanged .coderabbit.yaml`, and each artifact under "Artifacts" as `Unchanged <id> at <path>`, or `Unchanged <id>:` followed by its outputs. A lock that leaves the files as they are now names them too: `Would lock <id> <version>; its files in the project already match: <path>`, or a trailing colon followed by the outputs. The `changes` field of `apply --json` and of the MCP `dry_run_apply` and `apply_recipe` results carries them with `type: "unchanged"`.
- The `changes` field of `artifacts install --json` and `artifacts update --json` now also holds an entry with `type: "unchanged"` for each output that already matches and for an up-to-date `.coderabbit.yaml`. Read `type`, not whether `changes` is empty, to tell what was written.
- An updated `.coderabbit.yaml` in the bootstrap summary no longer ends with ": undefined".
