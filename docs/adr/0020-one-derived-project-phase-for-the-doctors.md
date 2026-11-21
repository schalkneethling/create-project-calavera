# ADR-0020: One Project Phase, Derived from the Project's Files, for Every Doctor

- **Status:** Proposed
- **Date:** 2026-11-21
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/1112
- **Decides:** how `doctor`, `artifacts doctor`, and `artifacts status` agree on where a project is in Calavera's lifecycle, so that none of them fails or warns about something that is expected at that point. One function derives the project's phase from the recipe, `.calavera/state.json`, `.calavera/artifacts.lock.json`, the marker that `eject` leaves in `.gitignore`, and the files those records name, and every one of the three commands reads it. Calavera stores no phase (owner decision of 2026-11-21 on #1112 and #994). The phases are `unmanaged`, `ejected`, `bootstrapped`, `composed`, `applied`, `drifted`, and `incomplete`. The same function also classifies each artifact and each managed file and gives the reason, so the two doctors never disagree about an artifact or about the phase. `doctor` reads the lock and fails at the levels #994 set for artifacts. Each command's `--json` result gains a `phase` string, and each item gains a computed `condition` with its reason, which is never persisted. A lock entry the recipe no longer selects, whose files were deleted, becomes a warning (#1111). The marker is defined by ADR-0017, Amendment 5, in the same pull request. The owner answered the open questions of the first draft on 2026-11-21 on #1112, and each answer is recorded in the decision it belongs to and in "Owner decisions". This document changes no code.

## Context

The owner asked on 2026-11-21, in the review of PR #1103 (#994), for a project lifecycle state, so that the doctors do not fail or report on things that are expected in the project's current phase. The example in #1112 is the time between `init`, which writes the recipe, and `apply`, which installs it. In that phase a selected artifact is not installed yet, and that is normal. `doctor` warns about it, `artifacts status` names it, and before the owner's decision on #994 `artifacts doctor` was about to fail on it.

The owner decided on the same day to derive the phase from the project's files in one shared function, not to store a phase that can go stale, and to decide the design in an ADR first. Two related decisions are already recorded on #994: a selected artifact that is not installed yet passes `artifacts doctor` with a note and exits 0, while missing or edited installed artifacts still fail; and a lock entry the recipe no longer selects, whose files were deleted, becomes a warning rather than a failure (#1111). This ADR builds on both and does not reopen them.

#1112's acceptance criteria ask for one function that derives the phase, used by all three commands, tests for each phase transition including the in-between state after `init`, and that the two doctor commands never give opposite answers about the same project. Its scope excludes "changing what each command checks, beyond reading the shared phase"; owner decisions 4, 5, and 10 extend `doctor`'s checks where this ADR says so. The sequencing map places this ADR in wave 7 of the `cli-experience` release and its implementation in wave 8, with #1111 following it (`docs/cross-repo/sequencing-map.md`, Section 0).

## What exists today

This section describes how each command and each record defines a project's state today, from the code, and then where the commands disagree. The commands run in the project folder, and `--config` names the recipe, which defaults to `calavera.config.json` (`CONFIG_FILE`, `packages/cli/src/project-local-commands.js:8`).

### The records

**The recipe** (`calavera.config.json`) is the person's declaration of what the project should have: a profile, integrations, scripts, and the AI artifacts in its `ai` list. `init` writes it, the Composer saves it, and `apply` writes it when it records an answer. The recipe schema requires `profile` (`apps/composer/public/calavera.config.schema.json`, `required`), and `apply` refuses a recipe without one. Calavera keeps no record of the recipe's text (ADR-0017, "What Calavera writes into a project today").

**The state** (`.calavera/state.json`) records what Calavera wrote: `profile`, `integrations`, `managedFiles` with a hash for each, `aiArtifacts` with a hash for each, `aiWiring`, `gitignoreBlocks`, and `qualityScript` (`packages/cli/src/state.js:24-34`). Several commands write it. The bootstrap (`--init`) writes it with the base skill's record (`agentBootstrap`, `packages/cli/src/index.js:4646`, written at `:4769`). `apply`, `clean`, `artifacts install`, and `artifacts update` rewrite it, and so do `artifacts status --check-updates` and `artifacts doctor --check-updates`, which record the artifact cache block (`artifact-lifecycle.js:608-616`). The state file's existence therefore does not show that `apply` ran.

Its `profile` does. `stateShowsEarlierApply` returns true when `profile` is set, because no other command sets it and `apply` records it on every run (`state.js:36-49`, written at `index.js:4092` from `recipe.profile`, `index.js:3780`). `apply` already relies on this signal to decide whether the project's scripts are Calavera's to compare (`index.js:3056`, `index.js:3578`). After `apply`, the state also keeps the record of an artifact the recipe no longer selects, so that `clean` can remove its unedited output (#829, `index.js:4077-4084`).

**The lock** (`.calavera/artifacts.lock.json`) records each installed artifact package: its ID, version, channel (`tag`), destination, and hashes (`readLock`, `packages/cli/src/artifact-lifecycle.js:1192`). `apply`, `artifacts install`, and `artifacts update` write it. The bootstrap does not, so the base skill it installs has a state record and no lock entry. Only `artifacts install` and `artifacts update` drop the lock entry of an artifact the recipe no longer selects, and they leave its files in place (#992; `keptEntries: []` at `artifact-lifecycle.js:985`, reported at `:993-999`). `apply` keeps every existing entry (`keptEntries: lock.artifacts`, `artifact-lifecycle.js:359`), and `clean` rewrites only the state and never touches the lock. A person who deselects an artifact and runs `clean` therefore ends with its files and state record removed and its lock entry kept, which is the case #1111 is about.

**Managed files that were edited.** `apply` and `update` refuse to overwrite a managed file whose contents differ from both the planned contents and the hash its state record holds, unless the two are equal JSON or the person passes `--reown-managed-file` for it (`assertSafeManagedFileWrite`, `index.js:2516-2547`). The dry run reports the same case as a `managed-file-conflict` error (`inspectManagedFilePlan`, `index.js:2780-2820`). An edit that matches what `apply` would write does not stop it.

**`eject`** removes the recipe, the state, the lock, and the rest of Calavera's footprint, and keeps the installed tooling and the recipe-selected artifacts other than the base skill (ADR-0017, Decisions 2 and 3). It deletes the recipe with the other footprint files, then the package folders and the lock, and the state last (ADR-0017, Decision 7). Before ADR-0017, Amendment 5, nothing in the project recorded afterward that Calavera managed it. `eject --yes` removes only items that match Calavera's records exactly (ADR-0017, Decision 5). It leaves the recipe, whose text Calavera does not record, and each package folder it cannot check, and it keeps the lock while a package folder stays (`selectEjectItems`, `packages/cli/src/eject.js:1662-1686`). It can still delete the state. A run of `eject --yes` on an applied project can therefore leave a recipe and a lock with no state file.

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

Each row is a probe run on 2026-11-21 against `main` at `0012c34`, in a folder created for it that holds a `package.json`. The applied project is hand-built: a recipe from `init --yes --profile minimal --ai-artifact skill-code-review`, a state with a `profile`, records for `.editorconfig` and `skill-code-review`, and a lock entry for `skill-code-review` and one for `skill-project-goal`, which the recipe does not select. The `eject --yes` row comes from the review of the first draft, which ran a real `artifacts install`, `apply --yes --no-install`, and `eject --yes`.

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

One function, in its own module of `packages/cli/src`, derives the phase. It takes the recipe path (`--config`) and the project folder. It reads the recipe first, then computes the repository root the way `doctor` does today for root-only integrations and Git hooks (#925, `index.js:6028-6036`), and then reads the state, the lock, the `.gitignore` marker (Decision 2), and the files the records name. It returns:

- the project's `phase` (Decision 2);
- the `condition` of each artifact and each managed file, each with its reason (Decision 3);
- the wiring findings that `artifactWiringFindings` returns today.

`doctor`, `artifacts doctor`, and `artifacts status` each call this function and render its result. None of them derives a phase or an item's condition on its own, so a rule changes in one place. `isArtifactHealthy` becomes a reading of an artifact's condition (Decision 4) rather than a separate rule. The function computes every phase, condition, and reason on each run and persists none of them (owner decisions 7 and 8).

The function itself writes nothing. Two writes that the artifact commands make today stay outside it and unchanged: the recovery of a pending artifact transaction, which both artifact commands run first, and the cache block that `--check-updates` records before it resolves packages (#960).

#1052 adds the read-only MCP tool for artifact status that ADR-0018, Decision 3 allows, as an adapter over the same core function as `artifacts status`. That tool therefore returns the same `phase` and `condition` fields without a separate rule.

### 2. The phases and how each is derived

The phase answers "where is this project in Calavera's lifecycle?" It depends on which records exist and, after an apply, on whether the recorded items of the current selection still match the files. The function checks the records in this order and stops at the first phase that fits:

```text
recipe file exists?
├─ no ─┬─ no state file and no lock entries ┬─ eject marker in .gitignore .. ejected
│      │                                    └─ no marker ................... unmanaged
│      ├─ state file without profile, no lock entries ...................... bootstrapped
│      └─ otherwise (state has profile, or lock entries) ................... incomplete
└─ yes ┬─ no state file, but lock entries .................................. incomplete
       ├─ no profile in the state, or no state file ........................ composed
       └─ state has profile ┬─ an item drifted .............................. drifted
                            └─ otherwise ................................... applied
```

| Phase          | Derived from                                                                                               | What it means                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unmanaged`    | No recipe, no state file, no lock entries, and no `eject` marker.                                          | Calavera never managed this project.                                                                                                                                                                    |
| `ejected`      | No recipe, no state file, no lock entries, and the `eject` marker in `.gitignore` (ADR-0017, Amendment 5). | `eject` finished removing Calavera's footprint, and the project keeps the tooling Calavera installed (owner decision 1).                                                                                |
| `bootstrapped` | No recipe, a state file without `profile`, and no lock entries.                                            | `--init` ran and wrote the guidance and the base skill; no recipe is composed yet. `init` is the expected next step.                                                                                    |
| `composed`     | A recipe, and either a state without `profile`, or neither a state file nor lock entries.                  | The recipe is written and `apply` has not run. Artifacts installed with `artifacts install` before `apply` are allowed, because that command writes their state records.                                |
| `applied`      | A recipe, a state with `profile`, and every recorded item of a selection matches its files.                | `apply` ran and nothing it recorded for the current selection has changed.                                                                                                                              |
| `drifted`      | A recipe, a state with `profile`, and at least one item in a drifted condition (Decision 3).               | `apply` ran, and something it recorded for a current selection is missing, edited, or no longer recorded.                                                                                               |
| `incomplete`   | A lock or a state that shows earlier work, while the recipe or the state that must go with it is gone.     | Some of Calavera's records were deleted while others remain: the recipe or the state was deleted by hand, an `eject` stopped partway, or `eject --yes` left the recipe and the lock (owner decision 9). |

**The marker and the derived phase.** The `eject` marker is the one fact this ADR reads that no other record implies, so it is the closest the design comes to a stored phase. It cannot go stale the way a stored phase would, for two reasons. Only `eject` writes it, and only after it has removed the whole footprint (ADR-0017, Amendment 5). The records also take precedence over it: a marker next to a recipe, a state, or a lock entry is ignored, so a project that someone starts to manage again after `eject` reads as `bootstrapped` or `composed`, and the next `apply` removes the marker. A deleted marker makes an ejected project read as `unmanaged`, which is the one hand edit it cannot survive. The marker is read only when the recipe and the state file are absent and the lock file is absent or holds no entries.

**The signal that `apply` ran.** `profile` is the signal because it is the one `apply` already uses (`stateShowsEarlierApply`), `apply` requires it in the recipe, and no other command writes it. One exception exists, described in `state.js:36-46`: an earlier release did not record the profile for an apply that installed only artifacts into a project whose state had none. Such a project reads as `composed` until its next `apply` records the profile. That is the only effect, because `composed` and `applied` differ in wording, not in exit status (Decision 4).

**A recipe with lock entries and no state file** is never the result of the normal commands, because every command that writes the lock also writes the state. It comes from a deleted state or from `eject --yes`, so it is `incomplete`, not `composed`. Reading it as `composed` would tell the person to run `apply`, which is wrong after an `eject`.

**One `eject --yes` outcome reads as `composed`.** In a project whose only artifact is the base skill from `--init`, there is no package folder (ADR-0017, Decision 5). When the skill matches its record, `eject --yes` removes the skill, the lock, and the state, and leaves only the recipe, because Calavera keeps no record of the recipe's text. A recipe alone is exactly what `init` leaves, so the derivation reads this project as `composed`, and the doctors tell the person to run `apply`. Owner decision 9 covers a recipe and a lock without a state, not a recipe alone. The derivation cannot tell the two causes apart without another signal: the `eject` marker cannot serve, because `eject --yes` writes it only when nothing is left (ADR-0017, Amendment 5), and a marker next to a recipe also follows `init` after an `eject`. This ADR therefore accepts `composed` for this case, and the pull request asks the owner to confirm it.

**Differences that are not drift.** Two kinds of difference do not make a project `drifted`, because each is the expected result of a recipe edit that a later command resolves. An item the recipe selects that has no record yet is `pending`, as everything is in `composed`; the next `apply` resolves it. A lock entry the recipe no longer selects is a leftover; the next `artifacts install` or `artifacts update` drops it. Both are reported (Decision 4), but the phase stays `applied`. A managed file the recipe no longer declares is not classified, as today, because `doctor` does not look at it and `clean` removes it.

### 3. The condition of each item and its reason

The function classifies two kinds of item that both doctors already look at: artifacts (each lock entry and each selection without one) and managed files (each file the recipe declares, with its state record if there is one). It keeps `selected` as today: true or false when a recipe exists, null when it does not. Each condition comes with a reason, a sentence in Calavera's own words that says what the function found and what resolves it, such as "the lock records version 1.0.0, and .agents/skills/code-review/SKILL.md differs from the hash the state records". A reason names paths, IDs, and versions, and never quotes a file's contents.

| Condition    | Artifact                                                                                           | Managed file                                                                                                                                                                                     | Makes the project `drifted`?                                   |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `pending`    | Selected, and no lock entry.                                                                       | Declared, no state record, and the file does not exist.                                                                                                                                          | No                                                             |
| `current`    | A lock entry, and every output exists, has a state record, and matches its hash.                   | A state record, the file exists, and the next `apply` would not stop on it.                                                                                                                      | No                                                             |
| `missing`    | A lock entry, and an output does not exist.                                                        | A state record, and the file does not exist.                                                                                                                                                     | Yes, after `apply`, for a selected artifact or a declared file |
| `edited`     | A lock entry, every output exists, and one differs from its state record's hash.                   | A state record, and the next `apply` or `update` would keep the file and stop on it: the same test as `inspectManagedFilePlan`'s `managed-file-conflict` for a recorded file (owner decision 5). | Yes, after `apply`, for a selected artifact or a declared file |
| `unrecorded` | A lock entry, every output exists, and one has no state record. Today's "not managed by Calavera". | Not used.                                                                                                                                                                                        | Yes, after `apply`, for a selected artifact or a declared file |

In the last column, "after `apply`" means the state has a `profile`; an artifact must also be selected, and a managed file must be declared by the recipe, which every classified managed file is. The order of the rows is the order of precedence: an artifact whose outputs are missing and unrecorded is `missing`, as today's report lists "files missing" first.

A managed file whose contents differ from its state record but that the next `apply` would not stop on is `current`. That is an edit that matches what `apply` would write, or that is equal JSON. The doctors stay silent about it (owner decision 5). To decide, the function plans the managed files with `apply`'s own planner and runs the same comparison as `inspectManagedFilePlan`, so the two cannot disagree.

Before `apply`, a selected artifact installed with `artifacts install` and then edited or deleted is still `edited` or `missing`, and still an error (Decision 4). The project stays `composed`, because `drifted` describes a difference from what `apply` recorded.

A `pending` artifact whose outputs already exist with a state record is installed without a lock entry. This happens when the recipe selects `skill-calavera` after the bootstrap installed it, or when the lock was deleted. Its reason says that the files are present and that the install command records them in the lock, so the person is not told that an installed artifact is missing.

Without a recipe, as in an `incomplete` project whose recipe was deleted, no managed file is declared, so the function classifies none and plans none.

A declared managed file that exists without a state record, such as the person's own `.editorconfig` before the first `apply`, is not classified and not reported, as today; `apply`'s own conflict handling covers it.

### 4. What each command reports, and at which level

An error fails the command's verdict and exits 1. A warning and a note do not. `doctor` calls its levels `"error"` and `"warning"` today and gains `"info"` for the note of owner decision 5. The artifact report calls its line levels `"error"`, `"warn"`, and `"info"`. This section uses "error", "warning", and "note" for both. `artifacts status` prints the same classification and always exits 0, as today.

**The phase line.** Each command prints at most one line about the phase itself:

| Phase          | `doctor`                                                                                                                                                                                                                                                                                            | `artifacts doctor`                                     | `artifacts status`             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| `unmanaged`    | Error: no recipe, state, or lock exists, so Calavera does not manage this project. The remedies are `--config <path>` when the recipe is saved elsewhere, and `init` to start (owner decision 2).                                                                                                   | The same error.                                        | Note, the same text.           |
| `ejected`      | Error: `eject` removed Calavera's records from this project, so there is nothing for a doctor to check. The remedies are to remove the doctor step that still runs, or `init` to manage the project again.                                                                                          | The same error.                                        | Note, the same text.           |
| `bootstrapped` | Warning: the project is bootstrapped and has no recipe yet, so run `init`, or pass `--config <path>` (owner decision 3).                                                                                                                                                                            | The same warning.                                      | Note, the same text.           |
| `composed`     | One warning that the recipe is not applied yet, which names each pending managed file and artifact once, and the `apply` command. It replaces today's separate "Missing managed file" and "Missing managed AI" warnings for those items.                                                            | Today's "Selected artifact not installed yet" warning. | Today's "not installed" lines. |
| `applied`      | No line; "Calavera doctor found no issues." when nothing else is reported.                                                                                                                                                                                                                          | Today's success verdict.                               | No line.                       |
| `drifted`      | No separate line; the item lines below name each difference.                                                                                                                                                                                                                                        | No separate line.                                      | No separate line.              |
| `incomplete`   | Error that names which records remain and which are missing, with the remedies that fit: `--config <path>` when the recipe is saved elsewhere, restore the missing record from version control and run `apply`, or run `eject` without `--yes` to finish removing the footprint (owner decision 9). | The same error.                                        | Note, the same text.           |

The `ejected` line is an error in both doctors, as for `unmanaged`, because the owner decided that a project without Calavera's files fails both doctors (owner decision 2), and an ejected project has none apart from the marker. The line differs from `unmanaged` only in what it says.

`doctor`'s other checks keep their wording and levels in every phase in which they run today: the missing `package.json` warning, the removed-toolchain warnings, the root-only and Git-hook refusals, and the missing Varlock schema warning.

**Artifacts.** Both doctors report every artifact the same way, at the same level. `doctor` reads the lock through the phase function, so it now reports lock entries, edits, and unrecorded outputs, which it does not see today, at the levels #994 set for `artifacts doctor` (owner decision 10).

| Condition    | Selected                                                                                        | Not selected                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pending`    | Warning, with the install or `apply` command (#994). In `composed`, folded into the phase line. | Not possible.                                                                                      |
| `current`    | Nothing.                                                                                        | Note in the artifact report, today's "Not selected" note; nothing in `doctor`.                     |
| `missing`    | Error (#994).                                                                                   | Warning naming the entry, with the remedy `artifacts install`, which drops the lock entry (#1111). |
| `edited`     | Error (#994).                                                                                   | Warning (owner decision 6).                                                                        |
| `unrecorded` | Error, as `artifacts doctor` reports it today.                                                  | Warning (owner decision 6).                                                                        |

In an `incomplete` project without a recipe, `selected` is null and the phase error already fails both doctors. Each artifact line then shows the level it would have if the recipe selected the artifact, for information.

**Managed files** (only `doctor` checks them):

| Condition | Level                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending` | Warning, with the `apply` command. In `composed`, folded into the phase line.                                                                                                                                                                                                                                                  |
| `missing` | Error, with the `apply` command, which writes the file again (owner decision 4).                                                                                                                                                                                                                                               |
| `edited`  | Note: the next `apply` or `update` keeps the file and stops on it, with three remedies: restore the contents Calavera recorded, remove the file so that `apply` writes it again, or pass `--reown-managed-file` to keep the edit (owner decision 5). Today `apply` names none of these when it refuses, so the wording is new. |

**Wiring** findings keep their current wording and levels (ADR-0015, Decision 5). A finding about a selected artifact counts toward `drifted`.

### 5. The agreement rule

The two doctors never disagree about the same artifact or about the phase (owner decision 10). For each artifact, both print the same condition, reason, and level, and each phase line has the same level in both. The implementation tests this on a fixture for each phase and each artifact condition, with both doctors run on the same folder.

Their exit statuses may still differ, but only because of a check that one doctor makes and the other does not, and the output then names that check:

- `doctor` alone checks managed files, wiring, the root-only and Git-hook refusals, and the recipe's integrations. When one of these is the only error, `doctor` exits 1 while `artifacts doctor` exits 0, and each such error names its check.
- `doctor` alone refuses to read the lock while `.calavera/artifact-transaction.json` exists, because a pending transaction means the lock may describe a rollback that has not happened yet. It reports one error that names the pending transaction and the remedy, any `artifacts` command, which recovers it first, and it reports no artifact condition. Otherwise the two doctors could classify the same artifact differently.
- `artifacts doctor` alone recovers a pending artifact transaction and, with `--check-updates`, plans the `artifact-cache` block (`artifact-lifecycle.js:105-125`). When either fails, `artifacts doctor` stops with an error that names the step, the transaction recovery or the cache block, and says that it is not a finding about the project's phase or an artifact.

To make this visible, `doctor`'s verdict names each failing check, for example "Calavera doctor found 1 error, in the managed files check, which artifacts doctor does not run.", and each issue in `doctor --json` carries a `check` field. The implementation pull request names the checks; this ADR fixes only that each error names the one it came from.

### 6. How hand edits and deleted files map to a phase

| What changed                                                                         | Phase afterward                       | What the doctors report                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The recipe was deleted after `apply`                                                 | `incomplete`                          | The phase error in both doctors, with `--config <path>` as the first remedy.                                                                              |
| The recipe gained an integration or an artifact                                      | Unchanged (`applied` stays `applied`) | The new items as `pending` warnings until `apply`.                                                                                                        |
| The recipe dropped an artifact                                                       | Unchanged                             | Its lock entry as not selected: a note in the artifact report while its files are current; nothing in `doctor`.                                           |
| The recipe dropped an artifact, then `clean` removed its files and state record      | Unchanged                             | Its lock entry as not selected and `missing`, a warning, until `artifacts install` drops the entry (#1111).                                               |
| `.calavera/state.json` was deleted after `apply`, and the lock has entries           | `incomplete`                          | The phase error in both doctors.                                                                                                                          |
| `.calavera/artifacts.lock.json` was deleted                                          | Unchanged                             | Each selected artifact as `pending`, with the "files are present" reason of Decision 3.                                                                   |
| A record or the recipe cannot be read or parsed                                      | None; the function stops              | The same error in all three commands, exit 1 in both doctors, naming the file, as today.                                                                  |
| A selected artifact's files were deleted or edited                                   | `drifted`                             | `missing` or `edited`, an error in both doctors.                                                                                                          |
| A managed file was deleted                                                           | `drifted`                             | `missing`, an error in `doctor`.                                                                                                                          |
| A managed file was edited, and the next `apply` would stop on it                     | `drifted`                             | `edited`, a note in `doctor`, exit 0.                                                                                                                     |
| A managed file was edited to what `apply` would write, or to equal JSON              | Unchanged                             | Nothing.                                                                                                                                                  |
| A recorded hook block or Claude Code group was edited or removed                     | `drifted`                             | Today's wiring warnings.                                                                                                                                  |
| An interactive `eject` finished                                                      | `ejected`                             | The `ejected` phase line.                                                                                                                                 |
| The `eject` marker was deleted after `eject`                                         | `unmanaged`                           | The `unmanaged` phase line.                                                                                                                               |
| `init` or `--init` ran after `eject`                                                 | `composed` or `bootstrapped`          | That phase's line; the marker is ignored, and the next `apply` removes it.                                                                                |
| `eject` stopped after deleting the recipe, in a project `apply` ran in               | `incomplete`                          | The phase error, whose remedy is to run `eject` again.                                                                                                    |
| `eject --yes` left the recipe, the lock, and a package folder, and deleted the state | `incomplete`                          | The phase error, which names the recipe, the lock, and the package folders that remain, and the remedy to run `eject` without `--yes` (owner decision 9). |

### 7. Unreadable records

When the recipe, the state, or the lock cannot be parsed or fails its shape check, the phase function stops, and all three commands report the same error and exit 1, as both doctors already do for an invalid state (the last row of "Where the commands disagree"). This ADR does not change what that error says. Today the message of a parse failure can include the file's text, because `JSON.parse`'s message is passed through; #1157 fixes that separately.

### 8. How the phase appears in `--json`

Each of the three results gains one field, `phase`, a plain string whose value is one of the seven phase names (owner decision 7). `artifacts status` reports the project's phase, not one computed from artifacts alone (owner decision 8).

Each item gains `condition`, an object with the condition's `name` and its `reason` (Decision 3). In `artifacts status` and `artifacts doctor`, the items are the existing artifact entries, which keep `installed`, `managed`, `locallyEdited`, and `selected` so that current readers keep working. `doctor`'s result gains `artifacts` and `managedFiles`, one entry per classified item, with its ID or path, `selected`, and `condition`, so that a reader can check the agreement rule from the two JSON results alone. `doctor`'s `issues` keep `level` and `message`, add `check` (Decision 5), and `level` gains the value `"info"`. `ok` keeps its meaning: false when any issue, item, or phase line is an error.

The phase, the conditions, and the reasons are computed on every run and never written to any file (owner decisions 7 and 8). None of these results is a frozen surface in the interface contract (`docs/cross-repo/interface-contract.md`), so adding fields needs no cross-repo request.

```json
{
  "command": "artifacts doctor",
  "phase": "drifted",
  "ok": false,
  "artifacts": [
    {
      "id": "skill-code-review",
      "selected": true,
      "locallyEdited": true,
      "condition": {
        "name": "edited",
        "reason": "The lock records version 1.0.0, and .agents/skills/code-review differs from the hash the state records."
      }
    },
    {
      "id": "skill-project-goal",
      "selected": false,
      "installed": false,
      "condition": {
        "name": "missing",
        "reason": "The recipe no longer selects skill-project-goal, and its files were deleted, so artifacts install drops its lock entry."
      }
    }
  ]
}
```

The example shows only the fields this ADR adds or names, and its reasons illustrate the kind of sentence, not final wording. A real result carries every field it carries today.

### 9. #1111 follows this ADR

#1111 implements the "not selected, `missing`" cell of Decision 4: a warning that names the lock entry and the remedy, `artifacts install`, which drops the entry (#992), with exit 0 when nothing else is wrong. As the sequencing map orders it, #1111 follows #1112's implementation in wave 8, so its classification lives in the phase function from the start. Its acceptance criteria hold under this ADR: a selected artifact that is `missing` or `edited` still fails, and `artifacts status` agrees with `artifacts doctor` because both read the same condition. Under this ADR, `doctor` reports the same warning, which it does not today because it never reads the lock.

### 10. How C8 holds

The phase function writes nothing, and its conditions and reasons are never persisted. The three commands keep the writes they make today and add none: the transaction recovery and the `--check-updates` cache block in the artifact commands (Decision 1). `eject` writes the marker as part of the list the person approved, or under `--yes` as Calavera's own new text, as ADR-0017, Amendment 5 describes. Only the CLI writes into projects; no approval boundary (`dry_run_apply`) is involved; no local edit is changed, only reported; nothing is written to `package.json`; and no conflict is resolved, so none needs a hard stop or a migration decision.

## Consequences

Both doctors fail in cases where one of them passes today. `doctor` fails for a selected artifact whose files were deleted, edited, or are unrecorded, which #994 already treats as failures in `artifacts doctor`; for a managed file that `apply` wrote and someone deleted; and for an `incomplete` project after `eject --yes`. `artifacts doctor` fails for an `unmanaged`, `ejected`, or `incomplete` project. A CI job that runs `doctor` and passed with a deleted skill or a deleted managed file will fail after the change, which is the intent. The implementation's changeset names each new failure.

`doctor` passes in one case where it fails today: a bootstrapped project without a recipe now warns and exits 0.

`doctor` prints fewer lines in `composed`: one warning that names each pending item once, instead of one warning per missing file. It prints a new note for an edited managed file that would stop the next `apply`, so the person learns about the conflict before `apply` refuses.

`doctor` now plans the managed files with `apply`'s planner to decide whether an edit would stop `apply`. That costs the planner's time on each run, but it reads nothing new and writes nothing.

`artifacts status` and `artifacts doctor` read managed files and wiring through the phase function so that they can report `drifted`, which costs a few more file reads. Their item lines still cover artifacts only; the phase field is the only place a managed file or a wiring block affects their output.

The implementation's tests build a fixture for each phase, run all three commands on it, and check the phase, the exit status, and that the two doctors' artifact lines and phase lines agree. They include these transitions:

- `unmanaged` → `composed` through `init`, the path the owner named, and `unmanaged` → `bootstrapped` → `composed` through `--init` and then `init`;
- `composed` → `applied` → `drifted` → `applied`, through `apply`, an edit or deletion, and `apply` again;
- `applied` → `incomplete` when the recipe or the state is deleted;
- `applied` → `incomplete` through `eject --yes` in a project with package folders and through a stopped `eject`, `applied` → `composed` through `eject --yes` in a project whose only artifact is the base skill (Decision 2), and `applied` → `ejected` through a finished interactive `eject`;
- `ejected` → `composed` through `init`, and back to `applied` through `apply`, which removes the marker.

## Owner decisions

The owner answered the ten open questions of the first draft on 2026-11-21 (https://github.com/schalkneethling/create-project-calavera/issues/1112#issuecomment-7069063918). Each answer is applied in the decision named after it.

1. **Ejected projects are their own phase, `ejected`, marked by a line in `.gitignore` that `eject` writes** (Decision 2; ADR-0017, Amendment 5). Rationale: the doctors can then tell a project that left Calavera on purpose from one Calavera never managed, and say so.
2. **A project without Calavera's files fails both doctors, with exit 1** (Decision 4). Rationale: a doctor that finds nothing to check is most likely a leftover CI step, a wrong folder, or a recipe saved elsewhere, and a failure surfaces each of these.
3. **A bootstrapped project warns and exits 0** (Decision 4). Rationale: the next step, `init`, is expected, which is the kind of case the owner asked the phase to stop failing on. The owner's comment labels the case "recipe composed, never applied", which describes `composed`, while the first draft's question was about `bootstrapped`, a project with no recipe; this ADR applies the answer to `bootstrapped`, and the owner confirms that reading in review.
4. **A managed file that `apply` wrote and someone deleted is an error** (Decision 4). Rationale: it is the same kind of breakage as a deleted installed artifact, which fails under #994.
5. **An edited managed file is a note with exit 0, and only when the next `apply` or `update` will keep the file and stop on it; otherwise the doctors stay silent** (Decisions 3 and 4). Rationale: people tune configuration files on purpose, so only an edit that will block the next run is worth the person's attention.
6. **A lock entry the recipe no longer selects, whose files are edited or unrecorded, is a warning** (Decision 4). Rationale: it is a leftover record, not a broken project, the same reason the owner gave for deleted files on #1111. This narrows #994's rule that edited installed artifacts fail to artifacts the recipe still selects.
7. **`phase` is a plain string** (Decision 8). Rationale: an agent branches on one stable value, and the details are in the items.
8. **Each item carries a computed `condition` with its reason, derived on every run and never persisted, and `artifacts status` shows the project-wide phase** (Decisions 3 and 8). Rationale: a computed reason cannot go stale, and one phase for the whole project is the shared answer #1112 asks for.
9. **What `eject --yes` leaves, a recipe and a lock without a state, is `incomplete`, and the doctors name what remains and the remedy** (Decisions 2, 4, and 6). Rationale: the person must choose between restoring the state and finishing `eject`, and the output gives them what they need to choose.
10. **The two doctors never disagree about the same artifact or about the phase; `doctor` reads the lock and fails at #994's levels for artifacts; exit codes may differ only for a check one doctor alone makes, and the output names that check** (Decisions 4 and 5). Rationale: each command keeps its own subject, and a person who sees different exit codes can tell at once which check caused them.

## Alternatives considered

**Store the phase in `.calavera/state.json`.** Each command that changes the project would write the phase. The owner rejected this on 2026-11-21, because a stored phase goes stale when a person edits or deletes files by hand, and every case in Decision 6 would need a writer. The `eject` marker is not this alternative: it records one event that no other file can show, it is written once by the command that causes it, and every other record takes precedence over it (Decision 2).

**Fold an ejected project into `unmanaged`.** The first draft proposed this, because after `eject` nothing recorded that Calavera had managed the project. The owner chose a separate phase with a marker (owner decision 1), so the doctors can name `eject` and its remedies.

**Read `eject --yes`'s leftovers as `composed`.** A recipe without a state looks like a project before its first `apply`. This was rejected because the doctors would then tell the person to run `apply` on a project they asked to leave Calavera (owner decision 9).

**Let each command derive its own phase from shared helpers.** This keeps the commands independent, but each command would combine the helpers its own way, and the opposite answers in "Where the commands disagree" came from exactly that. One function that returns both the phase and each item's condition leaves nothing to combine.

**Make the phase alone decide the exit status.** For example, `drifted` fails and every other phase passes. This was rejected because the owner's decisions are per item: a deselected lock entry whose files were deleted passes (#1111), while an edited selected artifact fails, and both can occur in the same `drifted` project. The phase sets the wording and the expected items; each item's condition sets its level.

**Require equal exit statuses from the two doctors.** This would make `artifacts doctor` report managed files, wiring, and the recipe refusals, so it would become a second `doctor`. The owner chose agreement per artifact and per phase instead, with each exit-code difference named (owner decision 10).
