---
"create-project-calavera": minor
---

`github-repository-controls` now applies only at the repository root, because GitHub reads `.github/` only there. When a recipe selects it and the project directory is not the repository root (the nearest ancestor with a `.git` entry), `apply`, `apply --dry-run`, `dry_run_apply`, and `apply_recipe` stop with a hard stop before any file is planned or written. The message names the project directory, the repository root, and the command to run there, with `--config <path>` when the recipe is saved in the member; apply a recipe that selects the integration at the repository root, or remove `github-repository-controls` from the member's recipe. A project that is not yet a git repository counts as its own root. `list_integrations`, `describe_integration`, and `explain_recipe` now say the integration applies at the repository root.
