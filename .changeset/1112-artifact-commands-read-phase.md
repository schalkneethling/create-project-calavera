---
"create-project-calavera": minor
---

`artifacts status`, `artifacts doctor`, and the MCP `artifact_status` tool now read the project's phase (ADR-0020). Each report starts with a line that names the phase, such as `composed` or `applied`, and what resolves it. The `--json` and MCP results gain `phase`, `phaseLine`, `phaseNotes`, `formatterFailures`, `managedFilePlanProblem`, and `cacheBlockProblem`, and each artifact gains a `condition` with its reason. No field was renamed or removed.

`artifacts doctor` now fails in these cases:

- The project is `unmanaged`, `ejected`, or `incomplete`, for example when `eject --yes` left the recipe and the lock without a state file.
- The project's formatter cannot load, or it refuses a managed file, because `apply` stops on the same thing.
- The recipe's managed files cannot be planned.
- A selected artifact's file cannot be read. Before, `artifacts status` and `artifacts doctor` stopped with an error on such a file.
- A selected artifact that has no lock entry, but whose files the state records, was edited or deleted.

`artifacts doctor` now passes for a lock entry the recipe no longer selects whose files are edited or not recorded, and warns about it instead. It also passes with a warning while the recipe is not applied yet.

`artifacts doctor` no longer rolls back a pending artifact transaction, because the rollback writes files. It reports the files the rollback would restore or remove, and exits 1. `artifacts status` still rolls the transaction back first.

`--check-updates` now records the artifact cache block only when a state file exists and the phase is `composed`, `applied`, or `drifted`. In any other phase it resolves through a temporary cache and writes nothing into the project. When the project's formatter cannot format the state that records the block, `artifacts status --check-updates` reports it as a note, writes no block, and exits 0, and `artifacts doctor --check-updates` reports it as an error and exits 1. Both resolve through a temporary cache, and the results gain `cacheBlockProblem`.

A lock entry with an invalid version, or another field Calavera cannot trust, now stops `artifacts status` as well as `artifacts doctor`, with an error that names the entry by its position.

`artifacts status` and `artifacts doctor` now load the project's formatter as `apply` does, to classify managed files. The read-only MCP tool still runs no project code: it reports a managed file that needs the formatter as `not-checked`, and says to run `doctor`.
