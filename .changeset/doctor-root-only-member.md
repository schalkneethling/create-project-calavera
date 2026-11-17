---
"create-project-calavera": patch
---

`doctor` run from a workspace member now reports an error when the recipe selects an integration that applies only at the repository root, such as `github-repository-controls`. The error is the message `apply` stops with, so it names the integration, the repository root, and the remedy: apply that recipe from the repository root, or remove the integration from this recipe (#997).
