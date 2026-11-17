---
"create-project-calavera": patch
---

The `--new` confirmation now describes the order Vite+ uses to pick the new project's package manager. Inside an existing project that is not a monorepo, a forwarded `--package-manager` wins over the package manager Vite+ detects there; only inside a monorepo does the detected package manager win over a forwarded one. A `VP_PACKAGE_MANAGER` environment variable overrides both. The previous text said that any existing workspace's package manager wins over a forwarded one.
