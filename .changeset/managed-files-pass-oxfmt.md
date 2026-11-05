---
"create-project-calavera": patch
---

In a project Vite+ manages, the JSON and Markdown files Calavera generates now pass `vp check` as written. These are `calavera.config.json`, `.stylelintrc.json`, `.htmlvalidate.json`, `knip.json`, `react-doctor.config.json`, `.github/repository-controls.json`, `docs/repository-controls.md`, `AGENTS.md`, `AGENTS.calavera.md`, `.agents/calavera/mcp.md`, `.mcp.json`, `.cursor/mcp.json`, and `opencode.json`. Calavera formats each one in memory with the project's own `vp fmt`, before the dry run, and never formats a file after writing it, so you no longer need to add these files to `fmt.ignorePatterns`. A project Vite+ does not manage gets the same JSON as before.

Because apply needs the project's `vite-plus` for this, a Vite+ project whose dependencies are not installed now stops with the `vp install` remedy in the dry run and in `apply --no-install` as well, and the install error no longer offers `--no-install` as a way around it.

The generated `docs/repository-controls.md` now has a blank line after the "Manual controls" list, so the closing paragraph renders on its own instead of inside the last list item. The generated agent guidance has a blank line after each `calavera-agent-bootstrap` marker. A managed file whose contents are unedited since an earlier apply is shown as changed in the dry run and is rewritten on apply, and a file with local edits is kept and reported, as before.
