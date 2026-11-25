---
"create-project-calavera": minor
---

`--new` now starts Vite+ through the package manager that launched Calavera when no `--package-manager` comes before `--new`. Outside an existing workspace, that package manager becomes the new project's package manager, so a pnpm user no longer gets an npm project by default. Calavera reads the package manager's name from `npm_config_user_agent`, as Vite+ does. npm, pnpm, Bun, and Yarn 2 or later choose their own runner. Calavera falls back to npm for an unset or empty value and for any other launcher. A `--package-manager` before `--new` still chooses the runner, and Calavera still adds no `--package-manager` to the arguments it forwards. When a runner Calavera chose cannot start, the error says how it was chosen and how to choose another.
