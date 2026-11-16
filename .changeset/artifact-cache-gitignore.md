---
"create-project-calavera": patch
---

`apply` now keeps `.calavera/cache/`, the npm cache that artifact packages resolve through, out of Git. While the recipe selects an artifact, or while the cache folder exists, apply writes `.calavera/cache/` in a marked `.gitignore` block, `# calavera:artifact-cache:start` to `# calavera:artifact-cache:end`, which the dry run lists and `.calavera/state.json` records like the integrations' blocks. When apply adds the block, it says that the cache does not belong in Git and that `.calavera/artifacts.lock.json` and `.calavera/packages/` are the files to commit (#841).
