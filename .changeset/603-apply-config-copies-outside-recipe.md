---
"create-project-calavera": minor
---

`apply --config <path>` with a recipe saved outside the project, such as one downloaded from the Web Composer, now copies the recipe byte for byte into the project root as `calavera.config.json` and applies it, so later commands find it without `--config`. `apply --dry-run` lists the copy and writes nothing. The project root is the current directory, which must contain a `package.json`: without one, apply refuses and names the directory instead of offering to create `package.json`. When the project already has a different `calavera.config.json`, apply stops without writing anything. A `--config` path inside the project behaves as before (#603).
