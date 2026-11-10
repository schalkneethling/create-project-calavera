---
"create-project-calavera": patch
---

When a recipe selects both `stryker` and `github-repository-controls`, the managed `.github/dependabot.yml` now groups `@stryker-mutator/*` in its `npm` entry, so Dependabot updates `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` in one pull request. The runner requires the exact core version as a peer dependency, so a pull request that bumped only one of them could not install. A recipe without `stryker` writes the same `.github/dependabot.yml` as before. If you applied both integrations earlier, the next `apply` rewrites `.github/dependabot.yml` when you have not edited it, and stops with a managed-file conflict when you have; copy any edit you want to keep, then run `apply --reown-managed-file .github/dependabot.yml` to let Calavera replace the file.
