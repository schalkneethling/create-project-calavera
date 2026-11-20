---
"create-project-calavera": patch
---

The `--new` confirmation now says which package manager Vite+ uses inside an existing project that declares none and has no lockfile or package-manager configuration file: Vite+ detects none there and uses the runner's package manager, the same one it uses outside a project. Runs of Vite+ 1.6.0 and 1.7.0 confirmed that this case does not fall back to pnpm when a package manager launched Vite+.
