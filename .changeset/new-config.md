---
"create-project-calavera": minor
---

`--new` accepts a recipe: pass `--config <path>` before `--new` to hand a recipe you composed, for example on the hosted Composer, to the project Vite+ scaffolds. Calavera reads the file and validates it before it starts `vp create`, and refuses a missing file or an invalid recipe with nothing run or written. After `vp create` exits with code 0 and Vite+ detection reports the scaffold as managed, Calavera copies the file byte for byte to `calavera.config.json` in the scaffolded directory, runs the bootstrap, and prints the preview and apply commands for that recipe. Calavera never applies it; `dry_run_apply` stays the approval boundary. A canceled, failed, or unmanaged scaffold copies nothing, an existing `calavera.config.json` in the scaffolded directory is not replaced, and `--dry-run` names the planned copy.
