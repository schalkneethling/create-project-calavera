# ADR-0020: One Project Phase, Derived from the Project's Files, for Every Doctor

- **Status:** Proposed
- **Date:** 2026-11-21
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/1112
- **Decides:** how `doctor`, `artifacts doctor`, and `artifacts status` agree on where a project is in Calavera's lifecycle, so that none of them fails or warns about something that is expected at that point. One function derives the project's phase from the recipe, `.calavera/state.json`, `.calavera/artifacts.lock.json`, and the files those records name, and every one of the three commands reads it. Calavera stores no phase (owner decision of 2026-11-21 on #1112 and #994). The phases are `unmanaged`, `bootstrapped`, `composed`, `applied`, `drifted`, and `incomplete`. The same function also classifies each artifact and each managed file, so the two doctors report an artifact with the same words and at the same level. Each command's `--json` result gains a `phase` field, and each artifact entry gains a `condition` field. A lock entry the recipe no longer selects, whose files were deleted, becomes a warning (#1111). This document changes no code.

## Context

The owner asked on 2026-11-21, in the review of PR #1103 (#994), for a project lifecycle state, so that the doctors do not fail or report on things that are expected in the project's current phase. The example in #1112 is the time between `init`, which writes the recipe, and `apply`, which installs it. In that phase a selected artifact is not installed yet, and that is normal. `doctor` warns about it, `artifacts status` names it, and before the owner's decision on #994 `artifacts doctor` was about to fail on it.

The owner decided on the same day to derive the phase from the project's files in one shared function, not to store a phase that can go stale, and to decide the design in an ADR first. Two related decisions are already recorded on #994: a selected artifact that is not installed yet passes `artifacts doctor` with a note and exits 0, while missing or edited installed artifacts still fail; and a lock entry the recipe no longer selects, whose files were deleted, becomes a warning rather than a failure (#1111). This ADR builds on both and does not reopen them.

#1112's acceptance criteria ask for one function that derives the phase, used by all three commands, tests for each phase transition including the in-between state after `init`, and that the two doctor commands never give opposite answers about the same project. Its scope excludes "changing what each command checks, beyond reading the shared phase". The sequencing map places this ADR in wave 7 of the `cli-experience` release and its implementation in wave 8, with #1111 following it (`docs/cross-repo/sequencing-map.md`, Section 0).

## What exists today

This section describes how each command and each record defines a project's state today, from the code, and then where the commands disagree. The commands run in the project folder, and `--config` names the recipe, which defaults to `calavera.config.json` (`CONFIG_FILE`, `packages/cli/src/project-local-commands.js:8`).

### The records

**The recipe** (`calavera.config.json`) is the person's declaration of what the project should have: a profile, integrations, scripts, and the AI artifacts in its `ai` list. `init` writes it, the Composer saves it, and `apply` writes it when it records an answer. The recipe schema requires `profile` (`apps/composer/public/calavera.config.schema.json`, `required`), and `apply` refuses a recipe without one. Calavera keeps no record of the recipe's text (ADR-0017, "What Calavera writes into a project today").

**The state** (`.calavera/state.json`) records what Calavera wrote: `profile`, `integrations`, `managedFiles` with a hash for each, `aiArtifacts` with a hash for each, `aiWiring`, `gitignoreBlocks`, and `qualityScript` (`packages/cli/src/state.js:24-34`). Several commands write it. The bootstrap (`--init`) writes it with the base skill's record (`agentBootstrap`, `packages/cli/src/index.js:4646`, written at `:4769`). `apply`, `clean`, `artifacts install`, and `artifacts update` rewrite it, and so do `artifacts status --check-updates` and `artifacts doctor --check-updates`, which record the artifact cache block (`artifact-lifecycle.js:608-616`). The state file's existence therefore does not show that `apply` ran.

Its `profile` does. `stateShowsEarlierApply` returns true when `profile` is set, because no other command sets it and `apply` records it on every run (`state.js:36-49`, written at `index.js:4092` from `recipe.profile`, `index.js:3780`). `apply` already relies on this signal to decide whether the project's scripts are Calavera's to compare (`index.js:3056`, `index.js:3578`). After `apply`, the state also keeps the record of an artifact the recipe no longer selects, so that `clean` can remove its unedited output (#829, `index.js:4077-4084`).

**The lock** (`.calavera/artifacts.lock.json`) records each installed artifact package: its ID, version, channel (`tag`), destination, and hashes (`readLock`, `packages/cli/src/artifact-lifecycle.js:1192`). `apply`, `artifacts install`, and `artifacts update` write it. The bootstrap does not, so the base skill it installs has a state record and no lock entry. Only `artifacts install` and `artifacts update` drop the lock entry of an artifact the recipe no longer selects, and they leave its files in place (#992; `keptEntries: []` at `artifact-lifecycle.js:985`, reported at `:993-999`). `apply` keeps every existing entry (`keptEntries: lock.artifacts`, `artifact-lifecycle.js:359`), and `clean` rewrites only the state and never touches the lock. A person who deselects an artifact and runs `clean` therefore ends with its files and state record removed and its lock entry kept, which is the case #1111 is about.

**`eject`** removes the recipe, the state, the lock, and the rest of Calavera's footprint, and keeps the installed tooling and the recipe-selected artifacts other than the base skill (ADR-0017, Decisions 2 and 3). It deletes the recipe with the other footprint files, then the package folders and the lock, and the state last (ADR-0017, Decision 7). After a complete interactive `eject`, nothing in the project records that Calavera managed it. `eject --yes` removes only items that match Calavera's records exactly (ADR-0017, Decision 5). It leaves the recipe, whose text Calavera does not record, and each package folder it cannot check, and it keeps the lock while a package folder stays (`selectEjectItems`, `packages/cli/src/eject.js:1662-1686`). It can still delete the state. A run of `eject --yes` on an applied project can therefore leave a recipe and a lock with no state file.

### `doctor`

`doctor` (`index.js:5999-6119`) builds a list of issues, each with the level `"error"` or `"warning"`, and its result is `{ command: "doctor", ok, issues }`, where `ok` is false only when an issue is an error (`index.js:6116`). The run exits 1 when `ok` is false (#1030, `index.js:7213-7222`). It reads the recipe and, for wiring only, the state. It never reads the lock, and it never recovers a pending artifact transaction.

- **No recipe:** an error, "Missing calavera.config.json. Run create-project-calavera init first." (`index.js:6005-6010`). The only other check that runs without a recipe is the warning for a missing `package.json` (`index.js:6012-6018`).
- **Checks of the recipe itself:** warnings for removed JavaScript and TypeScript toolchain integrations (#431), and errors when a root-only integration or an artifact that writes Git hooks is selected outside the repository root (#997, #1031, `index.js:6042-6057`).
- **A managed file the recipe declares that does not exist:** a warning, "Missing managed file" (`index.js:6060-6075`). The list comes from the recipe (`declaredManagedFiles`), not from the state, so `doctor` cannot tell a file that `apply` has not written yet from one that `apply` wrote and someone deleted. It does not compare hashes, so an edited managed file is not reported. A missing Varlock schema is a separate warning.
- **An output path of a selected AI artifact that does not exist:** a warning, "Missing managed AI skill" (`index.js:6093-6101`). Again the recipe is the source, so a selection that was never installed and an installed artifact whose files were deleted read the same. An edited artifact is not reported, and a lock entry the recipe no longer selects is not looked at.
- **The wiring that `apply` recorded** (ADR-0015, Decision 5): warnings for a missing or edited hook block or Claude Code group, and an error for a hook block whose script does not exist (`artifactWiringFindings`, `packages/cli/src/ai/artifact-wiring.js:571-679`, the error at `:621-625`).

### `artifacts status` and `artifacts doctor`

Both commands first recover a pending artifact transaction, which writes files, and then run the same function, `artifactStatus` (`runArtifactCommand`, `artifact-lifecycle.js:200-209`; `:588-756`). It reads the recipe if it exists, the lock, and the state, and it builds one entry per lock entry and one per selection without a lock entry (`artifact-lifecycle.js:626-720`). Each lock entry gets `installed` (every output path exists), `managed` (every output path has a state record), and `locallyEdited` (an output's hash differs from its state record) (`:628-661`), and `selected`, which is null when there is no recipe (`:678`). A selection without a lock entry gets `version: null` and an install command (`:682-718`).

`isArtifactHealthy` decides whether an entry is a problem: a selection without a lock entry is healthy, and a lock entry is healthy only when it is installed, managed, and unedited (`artifact-status-report.js:153-155`). The result's `ok` is true when every entry is healthy (`artifact-lifecycle.js:749`). `artifacts doctor` exits 1 when `ok` is false, and `artifacts status` always exits 0 (`index.js:7244-7255`). `artifacts doctor` prints a warning that names the selections not installed yet and a verdict line (`artifactDoctorVerdict`, `artifact-status-report.js:293-331`).

The health rule does not look at `selected`. A lock entry the recipe no longer selects, whose files were deleted, is therefore a failure, which is what #1111 changes. The rule also does not distinguish "no recipe" from "a recipe that selects nothing": with no recipe and no lock, the report is "The recipe selects no artifacts, and the artifact lock holds none." and `ok` is true (`artifact-status-report.js:170-173`).

### Where the commands disagree

Each row is a probe run on 2026-11-21 against `main` at `0012c34`, in a folder created for it that holds a `package.json`. The applied project is hand-built: a recipe from `init --yes --profile minimal --ai-artifact skill-code-review`, a state with a `profile`, records for `.editorconfig` and `skill-code-review`, and a lock entry for `skill-code-review` and one for `skill-project-goal`, which the recipe does not select. The `eject --yes` row comes from the review of this ADR, which ran a real `artifacts install`, `apply --yes --no-install`, and `eject --yes`.

| Project                                                               | `doctor`                                                                    | `artifacts doctor`                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| No recipe, state, or lock (never managed, or after `eject`)           | Error "Missing calavera.config.json", exit 1                                | "The recipe selects no artifacts, and the artifact lock holds none.", exit 0 |
| Bootstrapped with `--init`, no recipe yet                             | The same error, exit 1                                                      | The same report, exit 0                                                      |
| After `init`, before `apply`                                          | Two warnings, "Missing managed file" and "Missing managed AI skill", exit 0 | Warning "Selected artifact not installed yet", exit 0                        |
| Applied, selected artifact's files deleted                            | Warning "Missing managed AI skill", exit 0                                  | `skill-code-review ... files missing`, exit 1                                |
| Applied, selected artifact's files edited                             | Nothing about the artifact, exit 0                                          | `skill-code-review ... locally edited`, exit 1                               |
| Applied, a lock entry the recipe no longer selects, its files deleted | Nothing about the entry                                                     | `skill-project-goal ... files missing, not managed by Calavera`, exit 1      |
| Applied, then `eject --yes`: recipe and lock kept, state deleted      | Nothing about the artifact, exit 0                                          | The kept artifact "not managed by Calavera", exit 1                          |
| A state file with an invalid `aiArtifacts` entry                      | "Calavera state contains invalid aiArtifacts entries.", exit 1              | The same, exit 1                                                             |

Every row except the third and the last is an opposite exit status for the same project, which #1112's last acceptance criterion rules out. The third row is the in-between state the owner named: the two commands agree on the exit status, but `doctor` words an expected step as two problems. The sixth row is #1111. The base skill that the bootstrap installs has a state record and no lock entry, so neither command reports on it unless the recipe selects `skill-calavera`.

## Decision

### 1. One function derives the phase and classifies each item

One function, in its own module of `packages/cli/src`, derives the phase. It takes the recipe path (`--config`) and the project folder. It reads the recipe first, then computes the repository root the way `doctor` does today for root-only integrations and Git hooks (#925, `index.js:6028-6036`), and then reads the state, the lock, and the files they name. It returns:

- the project's `phase` (Decision 2);
- the `condition` of each artifact and each managed file (Decision 3);
- the wiring findings that `artifactWiringFindings` returns today.

`doctor`, `artifacts doctor`, and `artifacts status` each call this function and render its result. None of them derives a phase or an item's condition on its own, so a rule changes in one place. `isArtifactHealthy` becomes a reading of an artifact's condition (Decision 4) rather than a separate rule.

The function itself writes nothing. Two writes that the artifact commands make today stay outside it and unchanged: the recovery of a pending artifact transaction, which both artifact commands run first, and the cache block that `--check-updates` records before it resolves packages (#960).

#1052 adds the read-only MCP tool for artifact status that ADR-0018, Decision 3 allows, as an adapter over the same core function as `artifacts status`. That tool therefore returns the same `phase` and `condition` fields without a separate rule.

### 2. The phases and how each is derived

The phase answers "where is this project in Calavera's lifecycle?" It depends on which records exist and, after an apply, on whether the recorded items of the current selection still match the files. The function checks the records in this order and stops at the first phase that fits:

```text
recipe file exists?
├─ no ─┬─ no state file and no lock entries ............... unmanaged
│      ├─ state file without profile, no lock entries ..... bootstrapped
│      └─ otherwise (state has profile, or lock entries) .. incomplete
└─ yes ┬─ no state file, but lock entries ................. incomplete
       ├─ no profile in the state, or no state file ....... composed
       └─ state has profile ┬─ a selected item drifted .... drifted
                            └─ otherwise .................. applied
```

| Phase          | Derived from                                                                                           | What it means                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unmanaged`    | No recipe, no state file, and no lock entries.                                                         | Calavera never managed this project, or an interactive `eject` finished. The two cannot be told apart (open question 1).                                                                                                      |
| `bootstrapped` | No recipe, a state file without `profile`, and no lock entries.                                        | `--init` ran and wrote the guidance and the base skill; no recipe is composed yet. `init` is the expected next step.                                                                                                          |
| `composed`     | A recipe, and no `profile` in the state, or no state file and no lock entries.                         | The recipe is written and `apply` has not run. Artifacts installed with `artifacts install` before `apply` are allowed, because that command writes their state records.                                                      |
| `applied`      | A recipe, a state with `profile`, and every recorded item of a selection matches its files.            | `apply` ran and nothing it recorded for the current selection has changed.                                                                                                                                                    |
| `drifted`      | A recipe, a state with `profile`, and at least one selected item in a drifted condition (Decision 3).  | `apply` ran, and something it recorded for a current selection is missing, edited, or no longer recorded.                                                                                                                     |
| `incomplete`   | A lock or a state that shows earlier work, while the recipe or the state that must go with it is gone. | Some of Calavera's records were deleted while others remain: the recipe or the state was deleted by hand, an `eject` stopped partway (ADR-0017, Decision 7), or `eject --yes` left the recipe and the lock (open question 9). |

The name `incomplete` replaces the first draft's `orphaned`, because the phase now also covers a recipe whose state is missing, not only records whose recipe is missing.

`profile` is the signal for "apply ran" because it is the one `apply` already uses (`stateShowsEarlierApply`), `apply` requires it in the recipe, and no other command writes it. One exception exists, described in `state.js:36-46`: an earlier release did not record the profile for an apply that installed only artifacts into a project whose state had none. Such a project reads as `composed` until its next `apply` records the profile. That is the only effect, because `composed` and `applied` differ in wording, not in exit status (Decision 4).

A recipe with lock entries and no state file is never the result of the normal commands, because every command that writes the lock also writes the state. It comes from a deleted state or from `eject --yes`, so it is `incomplete`, not `composed`. Reading it as `composed` would tell the person to run `apply`, which is wrong after an `eject`.

Two kinds of difference do not make a project `drifted`, because each is the expected result of a recipe edit that a later command resolves. An item the recipe selects that has no record yet is `pending`, as everything is in `composed`; the next `apply` resolves it. A lock entry the recipe no longer selects is a leftover; the next `artifacts install` or `artifacts update` drops it. Both are reported (Decision 4), but the phase stays `applied`. A managed file the recipe no longer declares is not classified, as today, because `doctor` does not look at it and `clean` removes it.

### 3. The condition of each item

The function classifies two kinds of item that both doctors already look at: artifacts (each lock entry and each selection without one) and managed files (each file the recipe declares, with its state record if there is one). It keeps `selected` as today: true or false when a recipe exists, null when it does not.

| Condition    | Artifact                                                                                           | Managed file                                                                       | Makes the project `drifted`?           |
| ------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| `pending`    | Selected, and no lock entry.                                                                       | Declared, no state record, and the file does not exist.                            | No                                     |
| `current`    | A lock entry, and every output exists, has a state record, and matches its hash.                   | A state record, and the file exists (and matches, if open question 5 is accepted). | No                                     |
| `missing`    | A lock entry, and an output does not exist.                                                        | A state record, and the file does not exist.                                       | Yes, when selected and `apply` has run |
| `edited`     | A lock entry, every output exists, and one differs from its state record's hash.                   | A state record, and the file's hash differs (only if open question 5 is accepted). | Yes, when selected and `apply` has run |
| `unrecorded` | A lock entry, every output exists, and one has no state record. Today's "not managed by Calavera". | Not used.                                                                          | Yes, when selected and `apply` has run |

The order of the rows is the order of precedence: an artifact whose outputs are missing and unrecorded is `missing`, as today's report lists "files missing" first.

Before `apply`, a selected artifact installed with `artifacts install` and then edited or deleted is still `edited` or `missing`, and still an error (Decision 4). The project stays `composed`, because `drifted` describes a difference from what `apply` recorded.

A `pending` artifact whose outputs already exist with a state record is installed without a lock entry. This happens when the recipe selects `skill-calavera` after the bootstrap installed it, or when the lock was deleted. Its line says that the files are present and that the install command records them in the lock, so the person is not told that an installed artifact is missing.

A declared managed file that exists without a state record, such as the person's own `.editorconfig` before the first `apply`, is not classified and not reported, as today; `apply`'s own conflict handling covers it.

### 4. What each command reports, and at which level

An error fails the command's verdict and exits 1; a warning does not. `doctor` calls its levels `"error"` and `"warning"`, and the artifact report calls its line levels `"error"` and `"warn"`; this section uses "error" and "warning" for both. `artifacts status` prints the same classification and always exits 0, as today.

**The phase line.** Each command prints at most one line about the phase itself:

| Phase          | `doctor`                                                                                                                                                                                                                                                                        | `artifacts doctor`                                     | `artifacts status`             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| `unmanaged`    | Error: no recipe, state, or lock exists, so Calavera does not manage this project. The remedies are `--config <path>` when the recipe is saved elsewhere, and `init` to start (open question 2).                                                                                | The same error (open question 2).                      | Info, the same text.           |
| `bootstrapped` | Warning: the project is bootstrapped and has no recipe yet, so run `init`, or pass `--config <path>` (open question 3).                                                                                                                                                         | The same warning.                                      | Info, the same text.           |
| `composed`     | One warning that the recipe is not applied yet, which names each pending managed file and artifact once, and the `apply` command. It replaces today's separate "Missing managed file" and "Missing managed AI" warnings for those items.                                        | Today's "Selected artifact not installed yet" warning. | Today's "not installed" lines. |
| `applied`      | No line; "Calavera doctor found no issues." when nothing else is reported.                                                                                                                                                                                                      | Today's success verdict.                               | No line.                       |
| `drifted`      | No separate line; the item lines below name each difference.                                                                                                                                                                                                                    | No separate line.                                      | No separate line.              |
| `incomplete`   | Error that names which records exist and which are missing, with the remedies that fit: `--config <path>` when the recipe is saved elsewhere, restore the missing record from version control and run `apply`, or run `eject` without `--yes` to finish removing the footprint. | The same error.                                        | Info, the same text.           |

`doctor`'s other checks keep their wording and levels in every phase in which they run today: the missing `package.json` warning, the removed-toolchain warnings, the root-only and Git-hook refusals, and the missing Varlock schema warning.

**Artifacts.** Both doctors report every artifact the same way, at the same level. `doctor` reads the lock through the phase function, so it now reports lock entries, edits, and unrecorded outputs, which it does not see today. The owner's decision on #994 set these levels for `artifacts doctor`. This ADR extends them to `doctor`, because otherwise the fourth to seventh rows of "Where the commands disagree" stay opposite answers (open question 10).

| Condition    | Selected                                                                                                                                  | Not selected                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pending`    | Warning, with the install or `apply` command (owner decision on #994, for `artifacts doctor`). In `composed`, folded into the phase line. | Not possible.                                                                                      |
| `current`    | Nothing.                                                                                                                                  | Info in the artifact report, today's "Not selected" note; nothing in `doctor`.                     |
| `missing`    | Error (owner decision on #994, for `artifacts doctor`).                                                                                   | Warning naming the entry, with the remedy `artifacts install`, which drops the lock entry (#1111). |
| `edited`     | Error (owner decision on #994, for `artifacts doctor`).                                                                                   | Error, as today, unless open question 6 changes it.                                                |
| `unrecorded` | Error, as `artifacts doctor` reports it today.                                                                                            | Error, as today, unless open question 6 changes it.                                                |

In an `incomplete` project without a recipe, `selected` is null and the phase error already fails both doctors. Each artifact line then shows the level it would have if the recipe selected the artifact, for information.

**Managed files** (only `doctor` checks them):

| Condition | Level                                                                         |
| --------- | ----------------------------------------------------------------------------- |
| `pending` | Warning, with the `apply` command. In `composed`, folded into the phase line. |
| `missing` | Warning, as today; open question 4 asks whether it becomes an error.          |
| `edited`  | Not checked today; open question 5 asks whether `doctor` reports it.          |

**Wiring** findings keep their current wording and levels (ADR-0015, Decision 5). A finding about a selected artifact counts toward `drifted`.

**What the doctors share, and where they still differ.** For each artifact, the two doctors print the same condition at the same level, and each phase line has the same level in both, so the two never disagree about an artifact or about the phase. Their exit statuses can still differ, because each command checks things the other does not:

- `doctor` can fail while `artifacts doctor` passes, for a check `artifacts doctor` does not make: the root-only and Git-hook refusals, a missing hook script, and a missing managed file if open question 4 makes it an error. It can also stop on a recipe that fails `doctor`'s integration checks, which `artifacts doctor` does not run.
- `artifacts doctor` can fail while `doctor` passes when the recovery of a pending artifact transaction fails, or when `--check-updates` finds a conflict in the `artifact-cache` block (`artifact-lifecycle.js:105-125`). Neither is a statement about the project's phase or an artifact's condition; each is a failure of the command's own preparation, reported as such.

This ADR reads #1112's criterion "never give opposite answers about the same project" as "never disagree about the same item or the same phase". Open question 10 asks the owner to confirm that reading or to require equal exit statuses. The implementation tests the agreement on a fixture for each phase and each artifact condition, with both doctors run on the same folder.

### 5. How hand edits and deleted files map to a phase

| What changed                                                                         | Phase afterwards                              | What the doctors report                                                                                     |
| ------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The recipe was deleted after `apply`                                                 | `incomplete`                                  | The phase error in both doctors, with `--config <path>` as the first remedy.                                |
| The recipe gained an integration or an artifact                                      | Unchanged (`applied` stays `applied`)         | The new items as `pending` warnings until `apply`.                                                          |
| The recipe dropped an artifact                                                       | Unchanged                                     | Its lock entry as not selected: info while its files are current.                                           |
| The recipe dropped an artifact, then `clean` removed its files and state record      | Unchanged                                     | Its lock entry as not selected and `missing`, a warning, until `artifacts install` drops the entry (#1111). |
| `.calavera/state.json` was deleted after `apply`, and the lock has entries           | `incomplete`                                  | The phase error in both doctors.                                                                            |
| `.calavera/artifacts.lock.json` was deleted                                          | Unchanged                                     | Each selected artifact as `pending`, with the "files are present" wording of Decision 3.                    |
| A record or the recipe cannot be read or parsed                                      | None; the function stops                      | The same error in all three commands, exit 1 in both doctors, naming the file, as today.                    |
| A selected artifact's files were deleted or edited                                   | `drifted`                                     | `missing` or `edited`, an error in both doctors.                                                            |
| A managed file was deleted                                                           | `drifted`                                     | `missing`, a warning unless open question 4 makes it an error.                                              |
| A managed file was edited                                                            | `drifted` only if open question 5 is accepted | Nothing today; `edited` if open question 5 is accepted.                                                     |
| A recorded hook block or Claude Code group was edited or removed                     | `drifted`                                     | Today's wiring warnings.                                                                                    |
| An interactive `eject` finished                                                      | `unmanaged`                                   | The `unmanaged` phase line.                                                                                 |
| `eject` stopped after deleting the recipe                                            | `incomplete`                                  | The phase error, whose remedy is to run `eject` again.                                                      |
| `eject --yes` left the recipe, the lock, and a package folder, and deleted the state | `incomplete`                                  | The phase error, whose remedy is to run `eject` without `--yes` to finish (open question 9).                |

### 6. Unreadable records

When the recipe, the state, or the lock cannot be parsed or fails its shape check, the phase function stops, and all three commands report the same error and exit 1, as both doctors already do for an invalid state (the last row of "Where the commands disagree"). This ADR does not change what that error says.

Today that error can include the file's text: a probe with an invalid recipe printed `SyntaxError: Unexpected token 'F', ..."profile": FAKE_SECRE"... is not valid JSON` from both `doctor` and `artifacts doctor`, because `readJSON` (`packages/cli/src/utils/fs.js:84-86`) and `readJson` (`artifact-lifecycle.js:1206-1208`) pass `JSON.parse`'s message through. That is a diagnosability and secrets problem in its own right, outside #1112's scope, so it is proposed as a separate issue rather than decided here.

### 7. How the phase appears in `--json`

Each of the three results gains one field, `phase`, whose value is one of the six phase names. `artifacts status` and `artifacts doctor` add `condition` to each artifact entry, with one of the five condition names, next to the existing `installed`, `managed`, `locallyEdited`, and `selected`, which stay so that current readers keep working. `ok` keeps its meaning: false when any reported item or phase line is an error. `doctor`'s `issues` keep their shape, `{ level, message }`. None of these results is a frozen surface in the interface contract (`docs/cross-repo/interface-contract.md`), so adding fields needs no cross-repo request.

```json
{
  "command": "artifacts doctor",
  "phase": "drifted",
  "ok": false,
  "artifacts": [
    { "id": "skill-code-review", "selected": true, "condition": "edited", "locallyEdited": true },
    { "id": "skill-project-goal", "selected": false, "condition": "missing", "installed": false }
  ]
}
```

The example shows only the fields this ADR adds or names; a real result carries every field it carries today.

### 8. #1111 follows this ADR

#1111 implements the "not selected, `missing`" cell of Decision 4: a warning that names the lock entry and the remedy, `artifacts install`, which drops the entry (#992), with exit 0 when nothing else is wrong. As the sequencing map orders it, #1111 follows #1112's implementation in wave 8, so its classification lives in the phase function from the start. Its acceptance criteria hold under this ADR: a selected artifact that is `missing` or `edited` still fails, and `artifacts status` agrees with `artifacts doctor` because both read the same condition. Under this ADR, `doctor` reports the same warning, which it does not today because it never reads the lock.

### 9. How C8 holds

The phase function writes nothing. The three commands keep the writes they make today and add none: the transaction recovery and the `--check-updates` cache block in the artifact commands (Decision 1). Only the CLI writes into projects; no approval boundary (`dry_run_apply`) is involved; no local edit is changed, only reported; nothing is written to `package.json`; and no conflict is resolved, so none needs a hard stop or a migration decision.

## Consequences

Both doctors fail in cases where one of them passes today. `doctor` fails for a selected artifact whose files were deleted, edited, or are unrecorded, which the owner's #994 decision already treats as failures in `artifacts doctor`, and for an `incomplete` project after `eject --yes`. `artifacts doctor` fails for an `unmanaged` or `incomplete` project without a recipe, if open question 2 is answered as recommended. A CI job that runs `doctor` and passed with a deleted skill will fail after the change, which is the intent. The implementation's changeset names each new failure.

`doctor` prints fewer lines in `composed`: one warning that names each pending item once, instead of one warning per missing file.

`artifacts status` and `artifacts doctor` read managed files and wiring through the phase function so that they can report `drifted`, which costs a few more file reads. Their item lines still cover artifacts only; the phase field is the only place a managed file or a wiring block affects their output.

The implementation's tests build a fixture for each phase, run all three commands on it, and check the phase, the exit status, and that the two doctors' artifact lines agree. They include these transitions:

- `unmanaged` → `composed` through `init`, the path the owner named, and `unmanaged` → `bootstrapped` → `composed` through `--init` and then `init`;
- `composed` → `applied` → `drifted` → `applied`, through `apply`, an edit or deletion, and `apply` again;
- `applied` → `incomplete` when the recipe or the state is deleted;
- `applied` → `incomplete` through `eject --yes` and through a stopped `eject`, and → `unmanaged` through a finished interactive `eject`.

## Open questions for the owner

Each question names the options and the recommendation this draft follows. The owner's answers replace this section before the ADR is accepted.

1. **`ejected` as a phase.** #1112 lists `ejected` as an example phase. After a complete `eject`, nothing records that Calavera managed the project (ADR-0017, Decision 2), so a derived phase cannot tell it from a project Calavera never touched. The options are to fold both into `unmanaged`; to have `eject` leave a marker file, which reopens ADR-0017 and is the stored state the owner decided against; or to guess from kept artifacts in `.agents/`, which any project can hold. Recommendation: fold both into `unmanaged`, and word its line so it fits both.
2. **The verdict in `unmanaged`.** Today `doctor` exits 1 and `artifacts doctor` exits 0, an opposite answer. The options are both exit 1 with an error, or both exit 0 with a warning. Recommendation: both exit 1, because a doctor asked to check Calavera's files where none exist is most likely a leftover CI step after `eject`, a wrong folder, or a recipe saved elsewhere, and a failure surfaces all three.
3. **The verdict in `bootstrapped`.** Today `doctor` reports the missing recipe as an error and exits 1. The options are an error in both doctors, or a warning in both with exit 0. Recommendation: a warning, because `init` is the expected next step after `--init`. This is the same reasoning as the owner's example, a selected artifact before `apply`, applied one step earlier.
4. **A recorded managed file that was deleted.** Today it is a warning in `doctor`, and `doctor` cannot tell it from a file `apply` has not written yet. With the state record, the two can be told apart. The options are to keep the warning, or to make it an error. Recommendation: an error, because it is the same kind of breakage as a deleted installed artifact, which the owner decided fails. This changes `doctor`'s exit status for a case that has nothing to do with artifacts, so it needs the owner's decision.
5. **An edited managed file.** `doctor` does not compare managed files with their state hashes today, though `apply` stops on such an edit with a conflict. Reporting it is a new check, which #1112's scope excludes. The options are to keep not checking; to report it as a warning and count it toward `drifted`, in this work or in a follow-up issue; or to report it as an error. Recommendation: a warning, in a follow-up issue, because people tune configuration files such as `.editorconfig` on purpose, and `apply` already supports that case with `--reown-managed-file`, which treats a managed file's current contents as approved (`index.js:6901-6902`). An artifact's payload, by contrast, is a published package checked by its hash.
6. **A lock entry the recipe no longer selects, whose files are edited or unrecorded.** The owner's #1111 decision covers deleted files only, and the #994 decision says that edited installed artifacts fail. The options are to keep the error, as Decision 4 does, or to make it a warning, as for deleted files. A warning would amend the #994 decision for deselected artifacts. Recommendation: a warning, for the reason the owner gave on #1111: it is a leftover record, not a broken project, and the person has already chosen to drop the artifact.
7. **The shape of `phase` in `--json`.** The options are a string, as Decision 7 proposes, or an object that also carries the evidence, such as which records exist. Recommendation: a string, because the evidence is already in the result's items and an enum is the stable part an agent branches on.
8. **The scope of `phase` in `artifacts status`.** The options are the project's phase, as this draft proposes, so that a deleted managed file makes `artifacts status` report `drifted` while all its artifact lines are clean, or a phase computed from artifacts alone. Recommendation: the project's phase, because #1112 asks for one shared answer, and two phases with one name would be the disagreement this ADR removes.
9. **The project that `eject --yes` leaves.** A recipe and a lock with no state file. The options are `incomplete`, as Decision 2 proposes, with the remedy to finish `eject` without `--yes`; `composed`, which would tell the person to run `apply`; or a separate phase such as `ejecting`, detected from the package folders `eject --yes` leaves. Recommendation: `incomplete`, because the derivation cannot tell `eject --yes` from a state deleted by hand, and both need the person to choose between restoring and finishing.
10. **How strictly the doctors must agree.** Decision 4 reads "never give opposite answers" as "never disagree about the same item or phase", which lets their exit statuses differ for checks only one of them makes. Making `doctor` report artifacts at `artifacts doctor`'s levels follows from that reading, but it also adds checks to `doctor`, which #1112's scope otherwise excludes. The options are to confirm this reading; to require equal exit statuses, which would make `artifacts doctor` report managed files, wiring, and the recipe refusals; or to keep `doctor` from reading the lock, which leaves the fourth to seventh rows of "Where the commands disagree" as they are. Recommendation: confirm the reading, because each command keeps its own subject and the two can no longer contradict each other about anything both of them check.

## Alternatives considered

**Store the phase in `.calavera/state.json`.** Each command that changes the project would write the phase. The owner rejected this on 2026-11-21, because a stored phase goes stale when a person edits or deletes files by hand, and every case in Decision 5 would need a writer.

**Let each command derive its own phase from shared helpers.** This keeps the commands independent, but each command would combine the helpers its own way, and the opposite answers in "Where the commands disagree" came from exactly that. One function that returns both the phase and each item's condition leaves nothing to combine.

**Make the phase alone decide the exit status.** For example, `drifted` fails and every other phase passes. This was rejected because the owner's decisions are per item: a deselected lock entry whose files were deleted passes (#1111), while an edited selected artifact fails, and both can occur in the same `drifted` project. The phase sets the wording and the expected items; each item's condition sets its level.

**Keep `doctor` and `artifacts doctor` separate and only align `artifacts doctor`.** This would leave `doctor` passing a project whose installed skill was deleted or edited, which is the opposite answer #1112's last criterion rules out.
