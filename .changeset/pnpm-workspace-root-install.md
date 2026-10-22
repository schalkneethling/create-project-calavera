---
"create-project-calavera": patch
---

Apply no longer fails with `ERR_PNPM_ADDING_TO_ROOT` when it installs a recipe's development dependencies at the root of a pnpm workspace, such as one `vp create vite:monorepo` scaffolds. When `pnpm-workspace.yaml` in the project directory lists member packages, the install command gets `-w`: `vp add -D -w <packages>` in a project Vite+ manages, and `pnpm add --save-dev -w <packages>` in a pnpm project Vite+ does not manage. The dry run names the same command. Workspace members and single-package projects keep their current command.
