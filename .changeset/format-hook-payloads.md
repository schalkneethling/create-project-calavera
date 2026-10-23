---
"@schalkneethling/calavera-hook-auto-approve-safe-commands": patch
"@schalkneethling/calavera-hook-block-dangerous-commands": patch
---

The installed `hook.mjs` now ships in the form Oxfmt produces, so the Vite+ pre-commit hook (`vp staged`, which runs `vp check --fix`) no longer rewrites it in a project, and the next apply no longer refuses it as a local edit. A hook that `vp staged` already reformatted matches the new version exactly, so the next apply accepts it again. The behavior of both hooks is unchanged.
