---
"create-project-calavera": patch
---

`--new` now makes Vite+ use the package manager that Calavera's runner and confirmation name. Calavera removes `npm_config_user_agent` from the environment it gives `vp create`, so each runner sets its own value. Before, `npm create` and `bunx` passed on the value of the package manager that started Calavera, and Vite+ chose that package manager instead. This happened when Calavera fell back to npm, under an unrecognized launcher, and when `--package-manager npm` or `bun` before `--new` named another package manager than the one that started Calavera. Every other environment variable still passes through unchanged, except `npm_config_package` and `npm_config_call`, which Calavera already removed, and `COREPACK_ENABLE_AUTO_PIN`, which Calavera sets to `0` (#1080).
