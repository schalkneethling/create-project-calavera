---
"create-project-calavera": minor
---

`doctor` now reads the project's phase, as `artifacts doctor` does (ADR-0020). Its report starts with a line that names the phase and what resolves it, and lists what it found under headings. Its `--json` result gains `phase`, `phaseLine`, `artifacts`, and `managedFiles`. Each issue gains `check`, which names the check it comes from, and `level` gains `info`. No field was renamed or removed. The closing line names each check that failed, and says which of them `artifacts doctor` does not make.

`doctor` now fails in these cases:

- The project has no recipe, state, or lock (`unmanaged`). This replaces the "Missing calavera.config.json" error.
- `eject` removed Calavera's records (`ejected`), or only some records remain (`incomplete`).
- A pending artifact transaction exists. `doctor` names the files the rollback would restore or remove.
- A managed file that `apply` wrote was deleted, or cannot be read.
- A selected artifact's files are missing, cannot be read, are edited, or have no record. `artifacts doctor` already failed on these.
- The project's formatter cannot load or refuses a managed file, for example because `vite-plus` is declared but not installed.
- The recipe's managed files cannot be planned.

`doctor` now passes in one case where it failed: a project that `--init` bootstrapped and that has no recipe yet. It warns instead.

The "Missing managed file" and "Missing managed AI skill" warnings are replaced:

- A managed file that `apply` has not written yet is a warning with the `apply` command.
- A selected artifact that is not installed yet is a note.
- An edited managed file that the next `apply` would stop on is a note that lists the ways to keep the edit first.
- A file of your own at a managed path is a note whose remedies keep your file.

A `package.json` that cannot be parsed in a workspace member is now a finding instead of a stop, and `doctor` goes on to classify.
