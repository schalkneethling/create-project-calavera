---
"create-project-calavera": patch
---

`clean` no longer deletes the files of `github-repository-controls` while the recipe still selects it. After you removed another integration from the recipe, `clean --dry-run` listed `.github/repository-controls.json`, `.github/dependabot.yml`, `scripts/repository-controls.mjs`, and `docs/repository-controls.md` as stale, and `clean` would have deleted your repository policy, its administration script, and your Dependabot configuration. `clean` now judges a managed file stale from the same list of files that `apply` writes for the recipe, so it removes only the files of integrations the recipe no longer selects.
