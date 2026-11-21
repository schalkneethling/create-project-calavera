---
"create-project-calavera": patch
---

`vp create` now runs with `COREPACK_ENABLE_AUTO_PIN=0` under every runner, so Corepack no longer adds a `packageManager` field to a `package.json` above the working directory during the `pnpm dlx` or `yarn dlx` run that `--new` starts, whether that run succeeds or fails. That file is outside the new project, so you never approved the change. Corepack 0.32.0 and earlier pin by default, and Corepack 0.33.0 and later pin when `COREPACK_ENABLE_AUTO_PIN=1` is set; `0` turns auto-pin off in both. A `COREPACK_ENABLE_AUTO_PIN` value set in your environment is overridden for this one run only (#1080).
