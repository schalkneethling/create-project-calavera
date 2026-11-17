---
"create-project-calavera": patch
---

`artifacts install`, `artifacts update`, and `artifacts status --check-updates` now keep `.calavera/cache/` out of Git themselves. Before they resolve any package into the cache, they write the marked `artifact-cache` block in `.gitignore` and record it in `.calavera/state.json`, as `apply` does, and say why the cache is ignored. `artifacts doctor --check-updates` does the same. Their dry runs list the block and write nothing, and `artifacts status --check-updates --dry-run` no longer fills the project's cache. A block the person edited stops the command before it writes anything (#960).

`apply` now decides that it ran before from the profile recorded in `.calavera/state.json`, not from the file's existence. `artifacts install`, `artifacts update`, `artifacts status --check-updates`, and the bootstrap also write that file, so before this change the first apply after one of them could rename a `lint` or `lint:fix` script the person wrote (ADR-0013, Decision 6). A state file from an earlier release that apply wrote keeps its renames. Messages about a broken Calavera marker in `.gitignore` now name the command to run again.
