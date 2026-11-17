---
"create-project-calavera": patch
---

`init --yes` without `--profile` now writes a recipe with the `default` profile instead of showing the profile prompt. Without a terminal, that prompt ended as soon as standard input closed, so the run exited 0 and wrote no `calavera.config.json` (#940).
