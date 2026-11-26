---
"create-project-calavera": patch
---

`doctor` run from a workspace member now reports an error when the recipe selects an artifact that writes Git hooks, such as `skill-protected-branch-guard`. The error is the message `apply` stops with in a member that has its own `package.json`, so it names the artifact, the repository root, and the remedy: apply that recipe from the repository root, or remove the artifact from this recipe. When the recipe also selects an integration that applies only at the repository root, `doctor` reports both refusals, although `apply` stops at the first (#1031).
