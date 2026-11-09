---
"@schalkneethling/calavera-skill-calavera": patch
---

The Calavera skill now tells the agent to confirm each entry in `compose_recipe`'s `integrationInputs`, such as `github-repository-controls.defaultBranch`, with the user before `dry_run_apply`, and to show where each default came from. It also tells the agent to show the dry run's `integrationInputs` and `inputWarnings`, and that `apply_recipe` refuses an integration input the recipe does not record (#846, #844).
