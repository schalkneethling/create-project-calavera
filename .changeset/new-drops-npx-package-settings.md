---
"create-project-calavera": patch
---

`--new` with npm as the project's package manager no longer fails when Calavera itself was started with `npx --package create-project-calavera`, `npm exec --package`, or `npx -c`. Calavera now removes `npm_config_package` and `npm_config_call` from the environment it gives `vp create`. With `npm_config_package`, `npm create vite-plus@latest` looked for its command inside create-project-calavera and exited with code 127. With `npm_config_call`, it ran Calavera's own command line again instead of create-vite-plus. Every other environment variable passes through unchanged. Because the exit 127 cause is gone, an exit 127 through npm no longer shows the hint that named it.
