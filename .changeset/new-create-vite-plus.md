---
"create-project-calavera": patch
---

`--new` now starts Vite+ with `npm create vite-plus@latest --` when npm is the runner and with `bunx create-vite-plus@latest` when Bun is, instead of `npx --package vite-plus vp create` and `bunx --package vite-plus vp create`. A plain `npm create project-calavera -- --new` no longer exits with code 127: since Vite+ 1.3.0 picks the runner's package manager for the project, the old npm runner's `npm_config_package` setting reached the `npx` that Vite+ starts for the template and made it fail every time. The confirmation now says which package manager Vite+ will use unless `--package-manager` is forwarded after `--new`. When the npm runner still exits with code 127, the error names the remaining likely cause, Calavera itself started with `npx --package`, and its workaround, instead of the npx cache advice, which still appears for other npm failures. pnpm and Yarn are unchanged.
