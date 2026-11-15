---
"create-project-calavera": patch
---

`--new` now starts Vite+ through `create-vite-plus` for every runner: `pnpm dlx create-vite-plus@latest` and `yarn dlx create-vite-plus@latest` replace `pnpm dlx --package vite-plus vp create` and `yarn dlx --package vite-plus vp create`. Vite+ 1.4.0 and 1.6.0 complete `vp create` through these commands without a global `vp`. Forwarded arguments still reach Vite+ unchanged and in order.
