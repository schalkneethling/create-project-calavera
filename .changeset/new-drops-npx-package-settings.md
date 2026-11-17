---
"create-project-calavera": patch
---

`--new` with npm as the project's package manager no longer exits with code 127 when Calavera itself was started with `npx --package create-project-calavera`, `npm exec --package`, or `npx -c`. Calavera now removes `npm_config_package` and `npm_config_call` from the environment it gives `vp create`, so neither `npm create vite-plus@latest` nor the `npx` that Vite+ starts for the template looks for its command inside create-project-calavera any longer. Every other environment variable passes through unchanged. Because that cause is gone, an exit 127 through npm no longer shows the hint that named it.
