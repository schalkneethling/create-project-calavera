---
"create-project-calavera": patch
---

`doctor` now reports a missing `.github/repository-controls.json`, `.github/dependabot.yml`, `scripts/repository-controls.mjs`, or `docs/repository-controls.md` when the recipe selects `github-repository-controls`, as it does for every other managed file. Run from a workspace member, it checks these files at the repository root, where apply writes them, and names that root in the remedy, with a hint to pass `--config` when the recipe is saved elsewhere.
