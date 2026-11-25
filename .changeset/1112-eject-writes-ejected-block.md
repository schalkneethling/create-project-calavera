---
"create-project-calavera": minor
---

`eject` now marks a project it has finished ejecting, so `artifacts status` and `artifacts doctor` can tell it apart from a project Calavera never managed (ADR-0017, Amendment 5). Once it has removed everything else, `eject` adds a Calavera block named `ejected`, which holds one comment line, at the end of `.gitignore`, creating the file when the project has none, and then deletes `.calavera/state.json`. It adds the block only on a run that started from the recipe, the state, or the lock. The dry run and the list you approve show the block's exact lines, and the `--json` result carries them in a new `ejectedBlock` field with what the run did with it. A `--yes` run that leaves items for an interactive approval, or a run in which a removal fails, adds no block, and when the block cannot be written, `eject` keeps the state so the next run adds it. A second `eject` keeps a complete block and reports nothing to do.

`apply` removes a complete `ejected` block, because a project it writes into is managed again, and its dry run lists the removal. `init` and `--init` leave the block. An `ejected` block that holds other lines, or whose markers are unpaired or changed, stops both `eject` and `apply` before they write anything, with a remedy that names the block and quotes none of your lines.
