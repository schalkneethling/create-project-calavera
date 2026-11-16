---
"create-project-calavera": patch
---

`--new` now starts Vite+ through the package manager that launched Calavera when no `--package-manager` comes before `--new`, so `pnpm create project-calavera --new` produces a pnpm project instead of an npm project. Calavera reads the launcher from `npm_config_user_agent`, as Vite+ does. npm, pnpm, Bun, and Yarn 2 or later choose their own runner. Yarn 1, which has no `dlx` command, an unset or empty value, and any other launcher fall back to npm. A `--package-manager` before `--new` still chooses the runner, and Calavera still adds no `--package-manager` to the arguments it forwards.
