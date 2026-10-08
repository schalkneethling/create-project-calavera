---
"create-project-calavera": patch
---

When `vp create` fails under npm, the `--new` error now explains how to clear a stale `vite-plus` entry from the npx cache. An older `vite-plus` in that cache can make npm fail with `ERESOLVE` after a Vite+ release. The hint says it applies only when the npm output shows `npm error code ERESOLVE`, and it names `npm cache npx ls` and `npm cache npx rm <key>`. pnpm, Yarn, and Bun do not show it.
