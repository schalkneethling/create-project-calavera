---
"create-project-calavera": patch
---

`doctor --json` now prints a JSON result on every failure path, not only when the recipe cannot be resolved. A `.calavera/state.json` that doctor cannot read, parse, or accept stops doctor with an error issue that names the file, after any issue it found before. A wiring file Calavera recorded, such as `.vite-hooks/pre-commit` or `.claude/settings.json`, that exists but cannot be read, for example because it is a directory, is an error issue that names the file and the error code, and doctor goes on to check the other files. Doctor exits 1 in both cases, and neither issue quotes the file's text (#1206).
