---
"create-project-calavera": minor
---

After a recipe is applied, `dry_run_apply` and `apply --dry-run` report a managed file, `calavera.config.json`, or `package.json` script update whose result already matches the project with the new change type `unchanged`, and the CLI dry run ends with "Nothing to change" when every change is unchanged. `inspect_project` no longer raises `existing-config` for a file whose contents match its hash in `.calavera/state.json`, nor, once the recipe was applied, `existing-package-script` for a script that already has the value the recipe sets. `apply` skips rewriting unchanged files. A managed file with local edits still yields `managed-file-conflict`.
