---
"create-project-calavera": patch
---

`init --apply` now prints the same grouped dry-run summary as `apply --dry-run`, with Project, Integrations, Files, Scripts, Artifacts, and Notes headings, instead of its old one-line-per-field note. Each package, file, and artifact is named once: with `--apply`, the recipe summary shows only the profile, the closing lines no longer repeat the profile, package manager, and integrations, and a pointer the dry run already printed is not printed again after the apply (#1022).
