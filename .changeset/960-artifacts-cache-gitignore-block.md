---
"create-project-calavera": patch
---

`artifacts install`, `artifacts update`, and `artifacts status --check-updates` now keep `.calavera/cache/` out of Git themselves. Before they resolve any package into the cache, they write the marked `artifact-cache` block in `.gitignore` and record it in `.calavera/state.json`, as `apply` does, and say why the cache is ignored. `artifacts doctor --check-updates` does the same. Their dry runs list the block and write nothing, and `artifacts status --check-updates --dry-run` no longer fills the project's cache. A block the person edited stops the command before it writes anything (#960).
