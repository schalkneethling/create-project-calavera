---
"create-project-calavera": patch
---

In a project Vite+ manages, the JSON and Markdown files Calavera generates now pass `vp check` as written. These are `calavera.config.json`, `.stylelintrc.json`, `.htmlvalidate.json`, `knip.json`, `react-doctor.config.json`, `.github/repository-controls.json`, `docs/repository-controls.md`, `AGENTS.md`, `AGENTS.calavera.md`, `.agents/calavera/mcp.md`, `.mcp.json`, `.cursor/mcp.json`, and `opencode.json`. Calavera formats each one in memory with the project's own `vp fmt`, before the dry run, and never formats a file after writing it, so you no longer need to add these files to `fmt.ignorePatterns`. A project Vite+ does not manage gets the same JSON as before.

Because Calavera needs the project's `vite-plus` for this, a Vite+ project whose dependencies are not installed now stops with the `vp install` remedy in the dry run, in `apply --no-install`, in `init`, and in the `--init` agent bootstrap, including the one `--new` runs after `vp create`. The install error no longer offers `--no-install` as a way around it.

If you ran `vp fmt` on a `docs/repository-controls.md` from an earlier release, Oxfmt moved its closing paragraph into the last list item, so the file no longer matches what Calavera recorded and apply stops with a managed-file conflict. Apply again with `--reown-managed-files docs/repository-controls.md` to let Calavera replace it.

The generated `docs/repository-controls.md` now has a blank line after the "Manual controls" list, so the closing paragraph renders on its own instead of inside the last list item. The generated agent guidance has a blank line after each `calavera-agent-bootstrap` marker. A managed file whose contents are unedited since an earlier apply is shown as changed in the dry run and is rewritten on apply, and a file with local edits is kept and reported, as before.

When the recipe includes `editorconfig` and a `.editorconfig` in the project root or a parent folder sets indentation, line endings, the final newline, line length, or quote style differently from Calavera's, the dry run and apply stop and name the file and the setting, because the formatter cannot use a `.editorconfig` that apply has not written yet. Save Calavera's `.editorconfig`, which the error prints, in the project root, or leave `editorconfig` out of the recipe. In a project whose `.editorconfig` sets `end_of_line = crlf`, generated Markdown is now accepted with CRLF line endings instead of stopping with an error about text printed by `vite.config.ts`.
