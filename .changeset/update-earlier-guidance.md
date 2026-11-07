---
"create-project-calavera": patch
---

`--init` now brings agent guidance up to date when an earlier Calavera release wrote it. A whole-file `AGENTS.md`, `AGENTS.calavera.md`, and `.agents/calavera/mcp.md` are replaced with the current text when their text is exactly what a published release wrote, ignoring line endings, and the dry run reports each as an update. In a Vite+ project, the replacement passes `vp fmt --check`. Previously, `--init` skipped a whole-file `AGENTS.md` as "already present", and reported the other two as differing, which suggested that you had edited them. A file with any other text counts as your edit: Calavera keeps it, reports it as before, and never overwrites it. Calavera does not record these files in `.calavera/state.json`, so it recognizes an earlier release only by comparing text with the releases it knows, from 2.0.0 to 6.1.0.
