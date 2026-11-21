---
"create-project-calavera": patch
---

`init --apply` now prints the same grouped dry-run summary as `apply --dry-run`, with Project, Integrations, Files, Scripts, Artifacts, and Notes headings, instead of its old one-line-per-field note. Each package, file, and artifact is named once: with `--apply`, the recipe summary shows only the profile, an input that took its default is listed under its own heading by its place in the recipe, the closing lines no longer repeat the profile, package manager, and integrations, and a pointer the dry run already printed is not printed again after the apply. When init has already written `calavera.config.json`, the dry run headline says so instead of saying that no files were changed. `init` without `--apply` prints `Integrations: none` for a recipe without integrations, instead of an empty value (#1022).
