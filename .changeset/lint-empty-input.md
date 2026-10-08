---
"create-project-calavera": minor
---

The generated `quality` script now passes in a project without CSS or HTML files, and a real Stylelint or HTML Validate error still fails it. `lint:styles` and `lint:styles:fix` pass `--allow-empty-input` to Stylelint. `lint:html` runs `node scripts/lint-html.mjs "**/*.html"`, a new Calavera-managed wrapper that exits 0 when no HTML file matches, honoring `.htmlvalidateignore`, and otherwise runs `html-validate` with the same patterns and exit code. A recipe can set `integrationOptions["html-validate"].quality` to `false` to leave `lint:html` out of `quality` in a project without static HTML files; Calavera still generates `lint:html`, and the dry run reports the omitted step. The option lives in the recipe, so a later apply keeps it. In a project an earlier release applied to, the dry run shows each of these scripts as changed, with the old and the new command.
