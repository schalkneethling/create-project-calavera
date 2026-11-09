---
"create-project-calavera": patch
---

`clean` now tells a recipe problem apart from other failures when it works out which managed files the recipe selects. An invalid `github-repository-controls` option, a missing `defaultBranch`, or a non-object `integrationOptions` still stops `clean` with the recipe named and the advice to fix the recipe. Any other planner failure, such as a missing packaged template, stops `clean` with a message that points at the installation instead, and both failures keep the underlying error as the cause. The `dry_run_apply` tool description now names `ignoreChanges`, so an agent that reads the tool list learns that the dry run reports `.gitignore` and `.htmlvalidateignore` changes.
