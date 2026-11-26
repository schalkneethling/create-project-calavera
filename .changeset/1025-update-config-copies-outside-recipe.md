---
"create-project-calavera": patch
---

`update --config <path>` with a recipe saved outside the project now copies the recipe byte for byte into the project root as `calavera.config.json` before it applies it, as `apply --config` does since #603. `update --dry-run` lists the copy and writes nothing. The same checks apply: the current directory must contain a `package.json`, a different `calavera.config.json` already in the project stops `update` before it writes anything, and a link or a directory at `calavera.config.json` is refused. The refusals name `update` (#1025).
