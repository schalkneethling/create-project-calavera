---
"create-project-calavera": patch
---

`init --apply` now prints its dry run with the same grouped summary as `apply --dry-run`, with Project, Integrations, Files, Scripts, Artifacts, and Notes headings, instead of its old one-line-per-field note. Around that summary, the recipe summary and the closing lines no longer repeat what the dry run names. With `--apply`, the recipe summary shows only the profile, and an input that took its default is listed under its own heading by its place in the recipe. The closing lines no longer repeat the profile, package manager, and integrations, and a pointer the dry run already printed is not printed again after the apply. When init has already written `calavera.config.json`, the dry run headline says so instead of saying that no files were changed.

A dry run with `--no-install`, from `apply --dry-run --no-install` or `init --apply --no-install`, now says that the packages will not be installed and gives the command to install them later, instead of listing an install command that apply will not run. A real `apply --no-install` or `update --no-install` gives the same command after saying it did not install the packages. The `--json` and MCP results do not change: a dry run keeps the planned `installCommand`, and a real run keeps it `null`.

`init` without `--apply` prints `Integrations: none` for a recipe without integrations, instead of an empty value (#1022).
