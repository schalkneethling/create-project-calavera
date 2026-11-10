---
"create-project-calavera": patch
---

When a recipe selects both `stryker` and `github-repository-controls`, the managed `.github/dependabot.yml` now groups `@stryker-mutator/*` in its `npm` entry, so Dependabot version updates move `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` together in one pull request. The runner requires the exact core version as a peer dependency, so a pull request that bumped only one of them could not install. A recipe without `stryker` writes the same `.github/dependabot.yml` as before.
