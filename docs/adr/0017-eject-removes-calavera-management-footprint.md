# ADR-0017: `eject` Removes Calavera's Management Footprint and Keeps the Installed Tooling

- **Status:** Accepted (2026-11-17, Schalk Neethling, merged in #1004)
- **Date:** 2026-11-17
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/678
- **Decides:** what a new `eject` command removes from a project, what it keeps, and how it asks for approval. `eject` removes the files and the text Calavera keeps in a project to manage it (the footprint): the state, the recipe, the artifact lock and package copies, the artifact cache and its `.gitignore` block, the bootstrap guidance, the MCP setup notes and registration, a `.coderabbit.yaml` that Calavera created, and the base Calavera skill. It keeps every tool, managed file, `package.json` entry, and recipe-selected AI artifact other than the base skill that Calavera installed, and it writes nothing into a kept block or into a file that holds no footprint text. It changes nothing in `package.json`, and it reports each script there that runs Calavera and any development dependency on Calavera. Like `apply`, it starts with a dry run, and it deletes nothing until the person approves a list that names every deletion and edit and marks each item the person edited. `--yes` removes only items that match Calavera's records exactly. None of the C8 safety properties is weakened (Decision 9). The owner answered the open questions of the first draft on 2026-11-17 on #678, and each answer is recorded in the decision it belongs to.

## Context

The owner asked on 2026-10-09 for a way to stop Calavera managing a project while keeping what it installed. The use case is a template repository that someone scaffolds with Calavera and then does not want Calavera to keep managing (#678).

`clean` does not do this. It removes only stale items, which are managed files, AI artifacts, and wiring that the current recipe no longer selects, and it keeps every item the person edited (`clean` in `packages/cli/src/index.js:5657`). It never removes the state, the recipe, or the bootstrap guidance, and it rewrites `.calavera/state.json` at the end (`index.js:5904`). It can remove the base Calavera skill, though: apply keeps the record of every artifact the recipe does not select (`index.js:3649-3656`, #829), the bootstrap's skill is one of those, and `clean` treats every recorded artifact the recipe does not select as stale (`index.js:5686-5688`). A run of `--init` followed by `clean --yes` removes `.agents/skills/calavera`, which #1007 tracks. A project may therefore have no base skill by the time it runs `eject`.

The owner settled five points before the first draft of this ADR, and this ADR does not reopen them:

- **2026-10-09:** the base Calavera skill is part of the footprint and is removed by this command. Whether the bootstrap installs it at all is #673.
- **2026-10-09:** every file the command deletes, including a file the person edited, is listed, and nothing is deleted until the person approves that list. This holds for every destructive action in Calavera.
- **2026-10-09:** a dry run comes first, as with `apply`.
- **2026-11-14:** the command is `eject`.
- **2026-11-14:** `package.json` scripts that call Calavera are reported, not removed.

The first draft named 13 open questions. The owner answered all of them on 2026-11-17 in https://github.com/schalkneethling/create-project-calavera/issues/678#issuecomment-6958936279. Each answer appears below as "owner decision of 2026-11-17".

## What Calavera writes into a project today

This section lists every path Calavera writes, from the code, and says whether Calavera records what it wrote. The record matters because it is the only way a command can tell Calavera's text from an edit.

### Written by the bootstrap (`--init`, also run by `--new`)

`agentBootstrap` (`packages/cli/src/index.js:4142`) writes the following.

- **`.calavera/state.json`**, into which the bootstrap merges the base skill's record, creating the file when it does not exist (`index.js:4192-4195`, `index.js:4227-4230`). The path is `STATE_FILE` (`index.js:324`).
- **The agent guidance**, in one of three forms. When the project has no `AGENTS.md`, it writes the whole file, which starts with `<!-- calavera-agent-bootstrap -->` (`index.js:328`, `index.js:1833`). When `AGENTS.md` exists, the person chooses between a section appended to it, delimited by `<!-- calavera-agent-bootstrap:start -->` and `<!-- calavera-agent-bootstrap:end -->` (`index.js:329-330`, `index.js:3944`), and a separate file, `AGENTS.calavera.md` (`index.js:326`), which the person is told to merge into `AGENTS.md` by hand (`index.js:4238-4241`). A run with `--json` or `--yes`, or without a terminal, takes the separate file (`index.js:3799-3801`).
- **The MCP registration**, for the harness the person chooses: the `calavera` entry under `mcpServers` in `.mcp.json` (Claude Code) or `.cursor/mcp.json` (Cursor), the `[mcp_servers.calavera]` table in `.codex/config.toml` (Codex), or the `calavera` entry under `mcp` in `opencode.json` (OpenCode) (`packages/cli/src/utils/mcp-config.js:135-160`, `:188`, `:292-322`, `:329-344`). Calavera also creates the `mcpServers` or `mcp` object when it is missing, adds `$schema` with the value `https://opencode.ai/config.json` to `opencode.json` when its `$schema` is not a string (`mcp-config.js:305-308`), and creates `.codex/` or `.cursor/` when the folder is missing. The JSON files are rewritten whole through the project's formatter, and the Codex table is appended after the existing text with its trailing whitespace trimmed. The entry's launch command comes from `createMcpLaunchCommand`, which pins `create-project-calavera@<version>` and differs by package manager (`index.js:1874-1880`). A run with `--json` or `--yes`, or without a terminal, skips the registration unless `--mcp-harness` names a harness (`index.js:3833-3835`).
- **`.agents/calavera/mcp.md`**, the manual setup notes, written only when no registration was written (`index.js:4211-4220`).
- **The base Calavera skill**, the artifact `skill-calavera` (`index.js:331-333`, `index.js:342-344`), installed to `.agents/skills/calavera` (`packages/cli/src/ai/artifacts.js:233-235`) and recorded with a hash in the `aiArtifacts` list of the state, like every other AI artifact.
- **`.coderabbit.yaml`**, because installing any skill plans the CodeRabbit path filters (`ai/artifacts.js:502-504`). When the file does not exist, Calavera writes it whole from the constant `CODE_RABBIT_SKILL_CONFIG`, with a header comment and five filters, including `!.calavera/packages/**` (`ai/artifacts.js:39-52`, `:66-67`, written unformatted at `:589`). When it exists, Calavera adds the missing filters. Neither write is recorded.

Of these, only the skill has a record. The guidance, the setup notes, the MCP registration, and `.coderabbit.yaml` are not recorded in the state (`packages/cli/src/utils/earlier-guidance.js:4-8`). `--init` tells an earlier release's guidance from an edit by comparing the text with digests of what every published release wrote (`earlier-guidance.js:191`), after replacing the pinned `create-project-calavera@<version>` with a placeholder (`earlier-guidance.js:36-37`). That table covers the whole-file guidance, `AGENTS.calavera.md`, and `mcp.md`. It does not cover the appended section, the MCP entries, or `.coderabbit.yaml`.

### Written by `init`, `apply`, and the artifact commands

- **`calavera.config.json`**, the recipe (`index.js:322`). `init` writes it, `apply` and `apply_recipe` write it when they record an answer the person gave (`index.js:3286-3292`), `--new --config` copies it into the new project (`index.js:4890-4895`), and the person or an agent saves it from the Composer. Calavera keeps no record of its text.
- **`.calavera/state.json`**, which `apply` and `clean` rewrite. It records `integrations`, `files`, `managedFiles` with a hash for each, `aiArtifacts`, `aiWiring`, `gitignoreBlocks`, and `qualityScript` (`packages/cli/src/state.js:24-34`).
- **`.calavera/artifacts.lock.json`**, which records each artifact package's version, integrity, and `payloadHash` (`packages/cli/src/artifact-lifecycle.js:30`, `:58`).
- **`.calavera/packages/`**, the extracted package payloads that installs copy from, one folder per artifact ID and version (`artifact-lifecycle.js:34`, `:357`, `:388`).
- **`.calavera/cache/`**, the npm download cache (`artifact-lifecycle.js:32-33`), and the `artifact-cache` block in `.gitignore` that keeps it out of Git (`artifact-lifecycle.js:41`, ADR-0016 Amendment 1). The block is recorded in `gitignoreBlocks`. Until #960 lands, the `artifacts` commands can create the cache without the block.
- **`.calavera/.staging/`, `.calavera/.transactions/`, and `.calavera/artifact-transaction.json`**, which exist only while an artifact operation runs, or after one was interrupted (`artifact-lifecycle.js:35-36`, `:365`). The journal file means a rollback is still pending. Every `artifacts` command recovers it first, dry runs included (`runArtifactCommand`, `artifact-lifecycle.js:110`, through `recoverArtifactTransaction` at `:885`). `apply --dry-run` instead refuses while it exists, because recovery writes files: apply's artifact planning calls the recovery with `readOnly` set for a dry run (`artifact-lifecycle.js:153`, called from `index.js:3359`), and the recovery then throws (`artifact-lifecycle.js:886-889`).
- **Managed files**, such as `.editorconfig`, `knip.json`, `.htmlvalidateignore`, `scripts/lint-html.mjs`, and `scripts/repository-controls.mjs`, each recorded with a hash in `managedFiles`.
- **`package.json` scripts and development dependencies.** The scripts Calavera generates run the tools and the managed scripts, such as `knip`, `stryker run`, and `node scripts/lint-html.mjs` (`buildScripts`, `index.js:1620-1781`). None of them runs Calavera itself. The only state record about `package.json` is `qualityScript` (#230).
- **Recipe-selected AI artifacts** under `.agents/skills/`, `.agents/hooks/`, `.agents/agents/`, and `.codex/agents/` (`ai/artifacts.js:233-251`), each recorded with a hash in `aiArtifacts`. `skill-calavera` is also a cataloged artifact that a recipe can select (`packages/artifact-core/src/catalog.js:29`), and it installs to the same `.agents/skills/calavera`.
- **Their wiring**: a marked block in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and matcher groups in `.claude/settings.json`, recorded in `aiWiring` (ADR-0015, Decision 5).
- **Integration blocks in `.gitignore`**, one marked block per integration that declares ignore lines, recorded in `gitignoreBlocks` (ADR-0016), and Varlock's unmarked section, which has no record (`index.js:2186`).

## Decision

### 1. The command is `eject`, a separate command from `clean`

`create-project-calavera eject` is a new top-level command. It is not a flag on `clean`, because the two commands have opposite contracts:

| Question                                   | `clean`                                            | `eject`                                                                              |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Which items does it consider?              | Items the recipe no longer selects                 | Calavera's own footprint, selected or not                                            |
| What happens to an item the person edited? | Kept and reported as a skip                        | Listed as edited and removed on approval, or kept and reported (Decision 6)          |
| Does Calavera keep managing the project?   | Yes, and the state file is rewritten               | No, and the state file is removed                                                    |
| What happens to installed tooling?         | Removes stale managed files, artifacts, and wiring | Keeps every tool, managed file, and wiring, and every artifact except the base skill |

`eject` reuses the existing checks rather than adding parallel ones: `hashAiInstall` (`ai/artifacts.js:348`) for the base skill, `findEarlierGuidance` and its version normalization for the guidance files and the MCP entries (the normalization is private to `earlier-guidance.js` today, `:36-37`, so the implementation exports it), `createMcpLaunchCommand` for the launch commands, the marker helpers in `packages/cli/src/utils/marked-block.js` and the record rule of ADR-0016 Decision 4 for the `artifact-cache` block, `utils/json-rewrite.js`, which reports a JSON rewrite that would lose what the person wrote, for the MCP files, and the transaction recovery of the `artifacts` commands. `planGitignoreBlocks` (`packages/cli/src/ignore-lines.js:91`) cannot be reused as it is, because it removes a block only through a state record (`ignore-lines.js:113-138`), and `eject` must also handle a project whose state file is gone.

`eject` is a CLI command only and is not offered as an MCP tool. It removes the Calavera MCP registration, so an agent that ran `eject` through the Calavera MCP server would remove that server's registration during the session. The owner's approval rule also asks for the person to approve the list, which the CLI prompt does directly.

### 2. What `eject` removes

Each row names the check that tells Calavera's text from an edit. An item that passes its check is unedited. An item that fails it is listed as edited and removed after approval, unless the last column says otherwise. An item whose check needs a record that is missing, such as the base skill when the state file is gone, or a payload when the lock is gone, is treated as edited, as ADR-0016 Decision 2 treats a block with no record.

| Item                                                                                    | How `eject` tells an edit                                                                         | When the check fails                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `.calavera/state.json`                                                                  | None; it is Calavera's record                                                                     | Not applicable                                          |
| `calavera.config.json`                                                                  | None; listed as "the project's recipe; edits cannot be detected"                                  | Not applicable; removed only after interactive approval |
| `.calavera/artifacts.lock.json`                                                         | None; it is Calavera's record                                                                     | Not applicable                                          |
| `.calavera/packages/`                                                                   | Each payload's hash against `payloadHash` in the lock                                             | Listed as edited                                        |
| `.calavera/cache/`, `.calavera/.staging/`, and `.calavera/.transactions/`               | None; local download cache and transient files                                                    | Not applicable                                          |
| The `artifact-cache` block in `.gitignore`                                              | The block's lines against `gitignoreBlocks` (ADR-0016, Decision 4)                                | Listed as edited                                        |
| `AGENTS.md` written as a whole file                                                     | The text against the current guidance and `findEarlierGuidance`                                   | Kept and reported                                       |
| The marked section in an existing `AGENTS.md`                                           | The section against the current section text                                                      | Kept and reported                                       |
| Guidance with only the `<!-- calavera-agent-bootstrap -->` marker, such as a hand merge | None                                                                                              | Kept and reported                                       |
| `AGENTS.calavera.md`                                                                    | The text against the current guidance and `findEarlierGuidance`                                   | Listed as edited                                        |
| `.agents/calavera/mcp.md`                                                               | The text against the current notes and `findEarlierGuidance`                                      | Listed as edited                                        |
| The `calavera` MCP entry in each of the four harness files                              | The entry against the launch command for each package manager, with the pinned version normalized | Kept and reported as edited                             |
| `.coderabbit.yaml`, when Calavera created it                                            | The text against each text a release wrote                                                        | Listed as edited                                        |
| `.agents/skills/calavera`, whether or not the recipe selects `skill-calavera`           | `hashAiInstall` against the `aiArtifacts` record                                                  | Listed as edited                                        |

For a whole file, "remove" means delete it. For the `AGENTS.md` section, the `.gitignore` block, and an MCP entry, "remove" means delete only Calavera's text, markers included, and the blank-line separator Calavera added before it. Every other line or key stays. Calavera cannot always restore the file byte for byte: the append trimmed the person's trailing whitespace before adding the section or the Codex table (`index.js:3948-3951`, `utils/mcp-config.js:245-251`), and the JSON harness files are rewritten whole through the formatter. The dry run shows the resulting text, so the approval covers it.

**The recipe** (owner decision of 2026-11-17). `eject` lists `calavera.config.json` as "the project's recipe; edits cannot be detected" and deletes it only after approval.

**The guidance** (owner decisions of 2026-11-17). A whole-file `AGENTS.md` that matches neither the current guidance nor an earlier release's is kept and reported, so the person can remove Calavera's text themselves, because the file has no section markers that would let `eject` separate Calavera's text from the person's. The owner decided that older guidance is reported and left in place, with no table of earlier section texts needed first. Without that table, a marked section an earlier release wrote and a section the person edited look the same, so this ADR keeps and reports every marked section that differs from the current section text, edited or older. That extension to edited sections is this ADR's inference, not part of the owner's answer. "Older" applies to sections: a whole-file `AGENTS.md` that `findEarlierGuidance` recognizes as an earlier release's text is unedited and removed. Guidance that carries only the `<!-- calavera-agent-bootstrap -->` marker in a file `eject` does not otherwise remove, such as guidance the person merged by hand from `AGENTS.calavera.md`, is found by that marker, reported, and left in place.

**The MCP entries** (owner decision of 2026-11-17). `eject` removes a `calavera` entry only when it matches the launch command `createMcpLaunchCommand` produces for one of the supported package managers, in the shape the harness file uses (`mcp-config.js:135-160`, `:188`, `:309-316`), after replacing the pinned version with the placeholder that `findEarlierGuidance` uses (`earlier-guidance.js:36-37`). An entry that differs is reported as edited and kept. After removing the entry, `eject` also removes the `mcpServers` or `mcp` object when nothing else remains in it, and the `$schema` that Calavera added to `opencode.json` when nothing else remains in the file. Calavera keeps no record of whether it created that object or added that `$schema`, so `eject` infers it: an object left empty is Calavera's, and so is a `$schema` whose value is the one Calavera writes, `https://opencode.ai/config.json` (`mcp-config.js:305-308`). A `$schema` the person wrote with the same value is removed by that rule too, and the dry run shows it. The file itself stays, even when it is left empty, as ADR-0015 leaves an emptied hook script, and so do the `.codex/` and `.cursor/` folders.

**The `artifact-cache` block** (owner decision of 2026-11-17). An edited block is listed as edited and removed after approval, like a file. It is not a hard stop, unlike in apply (ADR-0016, Decision 2). A missing or changed `artifact-cache` marker is still a hard stop (Decision 7), because `eject` then cannot tell where the block ends.

**`.coderabbit.yaml`** (owner decision of 2026-11-17). A `.coderabbit.yaml` that Calavera created whole is part of the footprint, with the usual edit check. Calavera keeps no record of whether it created the file or added filters to an existing one, so `eject` decides by the first line. When Calavera creates the file, the text starts with `# CodeRabbit configuration — https://docs.coderabbit.ai/reference/yaml-template` (`ai/artifacts.js:47`), which every release that wrote the file used, including the earlier text replaced in commit ad107fd. When Calavera adds filters to an existing file, it edits the YAML document and never adds that line (`ai/artifacts.js:70-104`). A file that starts with that line is one Calavera created: it is unedited when its text equals a text some release wrote, kept as a table of earlier texts in the way `findEarlierGuidance` keeps the guidance, and otherwise it is listed as edited and removed after approval. A file without that line existed before, so `eject` reports its `!.calavera/packages/**` filter line and leaves the file as it is.

**The base skill** (owner decision of 2026-11-17). The base skill is always part of the footprint, whatever the recipe says. When the recipe selects `skill-calavera`, `eject` still removes `.agents/skills/calavera`. Its lock entry goes with `.calavera/artifacts.lock.json`, and its payload goes with `.calavera/packages/`, under `.calavera/packages/skill-calavera/<version>/` (`artifact-lifecycle.js:388`), after the payload's hash is checked against the lock like every other payload. `eject` deletes both the lock and the payload folder whole, so it does not edit individual lock entries.

A footprint item that is already gone counts as removed, which covers a base skill that `clean` already removed (#1007). `eject` removes `.calavera/` and `.agents/calavera/` when it has emptied them. It keeps either folder when it still holds a file `eject` does not name, and lists those files, because it removes only what it can name in the dry run. Every other folder or file that `eject` leaves empty, such as a `.gitignore` that held only the cache block, stays in place, as ADR-0015 and ADR-0016 leave an emptied hook script, settings file, or `.gitignore`.

`eject` looks for each item directly, not only through the state file. The guidance and MCP entries have no record, and a project whose state file the person already deleted still holds the rest of the footprint.

### 3. What `eject` keeps

`eject` keeps, without changing them, every managed file, every `package.json` script and dependency, every recipe-selected AI artifact except the base skill, the wiring of those artifacts in `.vite-hooks/` and `.claude/settings.json`, every integration block in `.gitignore`, Varlock's section in `.gitignore`, and a `.coderabbit.yaml` that Calavera did not create whole. Removing any of these is an uninstall, which #678 puts out of scope.

The wiring stays because it runs the artifacts that stay. Removing the `protected-branch-guard` blocks, for example, would leave the guard installed with nothing to run it, which ADR-0015 Decision 4 calls a failure.

**Markers on kept blocks** (owner decision of 2026-11-17). The integration blocks in `.gitignore` and the wiring blocks in `.vite-hooks/` keep their `calavera:<id>` markers. `eject` writes nothing into a kept block or into a file that holds no footprint text. The only files it edits are the ones that hold footprint text, and in them it changes only that text: `AGENTS.md` for the guidance section, `.gitignore` for the `artifact-cache` block, and the MCP harness files for the `calavera` entry.

### 4. What `eject` reports and leaves for the person

`eject` writes nothing to `package.json` (owner decision of 2026-11-14). It reports:

- Each script whose value runs a `create-project-calavera` or `create-project-calavera-mcp` executable, the two `bin` entries of the package (`packages/cli/package.json:28-31`), whether directly or through a package runner. The report names the script and its value and says that the script stops working once Calavera is gone. Because Calavera's generated scripts never run Calavera (`index.js:1620-1781`), every reported script is one that the person or another tool added.
- A development dependency on `create-project-calavera`, with the command that removes it for the project's package manager (owner decision of 2026-11-17). `packageManagerCommands` (`index.js:387`) has an install command for each package manager but no remove command, so the implementation adds one, checked against each package manager's documentation, and the Vite+ command in a project Vite+ manages, as ADR-0012 does for installs.
- Each guidance file or section and MCP entry that Decision 2 keeps, and the `.coderabbit.yaml` filter line in a file that existed before, with what the person can do about it.
- A footprint in another directory of the workspace (Decision 8).

### 5. The dry run and the approval

`eject --dry-run` lists every file and directory `eject` would delete, every edit it would make with the exact text it removes and the text the file holds afterward, every file it would keep in a folder it cannot empty, and every item Decision 4 reports. It changes nothing.

`eject` without `--dry-run` shows the same list, marks each item the person edited since Calavera wrote it, and asks for approval. It deletes nothing until the person approves the whole list, and declining cancels the run with nothing changed. An edited item is removed after approval, as the owner decided on 2026-10-09. An item whose edit `eject` cannot detect, which is only the recipe, says so in the list rather than appearing unedited.

**`--yes`** (owner decision of 2026-11-17). A run that cannot ask, because of `--json` or no terminal, refuses unless `--yes` is given, writes nothing, and prints the list. `--yes` is the existing confirmation flag (`index.js:1300`), and `--new` already uses it to confirm a run that cannot ask (`index.js:4780`). With `--yes`, `eject` removes only the items that match Calavera's records exactly, and prints the list of what it removed and what it left. Anything edited or unknown needs an interactive approval. This ADR reads "Calavera's records" broadly: an item matches when its check in Decision 2 passes, whether against a record in the project (a hash in the state or the lock, or the lines in `gitignoreBlocks`) or against a text Calavera is known to have written (the guidance and CodeRabbit texts of each release, and the launch command for each package manager). The state file, the lock, the cache, and the transient folders have no check and are Calavera's own, so they count as matching. The recipe can never be checked, so `--yes` never removes it.

`--yes` keeps a record only while an item it leaves still needs that record: `.calavera/state.json` while it leaves the base skill or an `artifact-cache` block, and `.calavera/artifacts.lock.json` while it leaves a payload in `.calavera/packages/`. The recipe needs no record, so leaving it keeps neither. A `--yes` run on a project whose only unchecked item is the recipe therefore removes the state and the lock, and Calavera stops managing the project, because `apply` needs the state's records and the recipe alone does not restore them. Running `eject` again in a terminal removes the recipe after approval. A second `--yes` run reports that only items needing an interactive approval remain.

### 6. Outcomes for an edited or unchecked item, in one place

An item whose check fails, or that has no check, has one of three outcomes. The table collects them and names the rule behind each, so the implementation can test each row.

| Outcome                                  | Items                                                                                           | Rule                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Listed as edited, removed after approval | `.calavera/packages/` payloads, `AGENTS.calavera.md`, `.agents/calavera/mcp.md`, the base skill | Owner decision of 2026-10-09                                                             |
| Listed as edited, removed after approval | The `artifact-cache` block, a `.coderabbit.yaml` that Calavera created                          | Owner decisions of 2026-11-17                                                            |
| Kept and reported                        | A whole-file `AGENTS.md`, a marked section, marker-only guidance, an MCP entry                  | Owner decisions of 2026-11-17, and this ADR's inference for edited sections (Decision 2) |
| Removed only after interactive approval  | `calavera.config.json`, which has no check                                                      | Owner decisions of 2026-11-17                                                            |

### 7. The order of the writes and the hard stops

**A pending artifact transaction** (owner decision of 2026-11-17). When `.calavera/artifact-transaction.json` exists, `eject` recovers the transaction before it plans, the same way every `artifacts` command does (`artifact-lifecycle.js:110`). Read literally, that answer would make `eject --dry-run` recover too, as `artifacts install --dry-run` does. This ADR narrows it for the dry run, because recovery writes files and #678's first acceptance criterion says a dry run changes nothing. `eject --dry-run` therefore refuses, as `apply --dry-run` does (`artifact-lifecycle.js:153`, `:886-889`), and says that `eject` without `--dry-run`, or any `artifacts` command, recovers the transaction first. The owner confirms this narrowing in review.

`eject` deletes `.calavera/cache/` before it removes the `artifact-cache` block, so a run that stops between the two never shows the cache in `git status`. It then removes Calavera's text from the other shared files, deletes the remaining footprint files and folders, deletes `.calavera/packages/` before `.calavera/artifacts.lock.json`, and deletes `.calavera/state.json` last. A run that stops partway therefore leaves every record that a remaining item needs for its check, and the next `eject` finds the rest of the footprint and continues.

`eject` stops before it writes or deletes anything when it cannot plan safely: when a guidance marker in `AGENTS.md` or an `artifact-cache` marker in `.gitignore` is unpaired or changed (a broken marker on a kept block does not stop it, because `eject` does not touch that block), when an MCP harness file cannot be parsed, or when the recovery of a pending transaction fails. Each stop names the file and the remedy.

### 8. Workspaces

`eject` removes only the footprint in the directory it runs in, as `clean` does (owner decision of 2026-11-17). It also names a footprint in another location, so the person can run `eject` there too. Run in a workspace package, it looks for every footprint item of Decision 2 at the repository root that `findRepositoryRoot` returns (`packages/cli/src/repository-root.js:36`). Run at a workspace root, it looks for them in the workspace packages that `workspacePackagePatterns` lists (`index.js:444`). A footprint it names elsewhere is reported, not removed.

A second run reports nothing to do when no footprint item from Decision 2 that `eject` would remove exists. The items Decision 4 reports are reported on every run, because they remain until the person acts on them, but they do not count as work for `eject`. Items that `--yes` left for an interactive run do count, because `eject` removes them once the person approves.

### 9. How C8 holds

No C8 test changes.

- **Only the CLI writes into projects.** `eject` is a CLI command, and nothing asks the person or an agent to edit a file.
- **The dry run is the approval boundary.** `dry_run_apply` is the boundary for apply. `eject` keeps a boundary of the same kind for itself: its dry run lists every deletion and edit, with the text, and an interactive run removes nothing the list it shows does not name. A `--yes` run removes only items that match Calavera's records exactly (Decision 5), so it never removes an edit nobody approved.
- **Local edits are preserved and never overwritten.** `eject` keeps every line and key outside Calavera's markers and entries, and it writes nothing into a kept block or into a file that holds no footprint text. It deletes an edited footprint item only after the person approves a list that marks the item as edited, which is the owner's 2026-10-09 rule for destructive actions. The owner decided on 2026-11-17 that this rule and C8 are compatible, because no edit is removed without the person seeing it marked and approving it, so no C8 test changes.
- **Artifacts are not recorded in `package.json`.** `eject` writes nothing to `package.json`.
- **Conflicts surface as a hard stop.** The cases in Decision 7 stop `eject` before it writes or deletes anything.

## Consequences

A project that runs `eject` keeps working with its tools: `vp check`, the generated scripts, and the installed artifacts other than the base skill run as before, because nothing they read is removed. Commands that need Calavera, such as `apply`, `doctor`, and `artifacts update`, no longer have a state or a recipe to work from. Running `--init` and `apply` again would start management over.

#678's acceptance criteria ask that no Calavera state, recipe, guidance, MCP registration, or base skill remains after `eject`, and that a second run reports nothing to do. The owner's 2026-11-17 decisions change what that means in four cases, and the implementation pull request tests the criteria in this form:

- Guidance that differs from the current text stays in place and is reported: a whole-file `AGENTS.md` the person edited, a marked section the person edited or an earlier release wrote, and guidance merged by hand.
- An MCP entry that does not match a current launch command stays and is reported. This includes an entry the person edited and an entry from an earlier release whose launch command had another shape, such as one without a pinned version.
- After a `--yes` run, the recipe remains, and so do the records a remaining item needs (Decision 5), until an interactive run removes them.
- A second run reports nothing to do when only reported items remain (Decision 8).

Some kept files still describe Calavera after `eject`. The managed `docs/repository-controls.md` tells the reader to edit the Calavera recipe and apply it again (`packages/cli/src/github-repository-controls.js:157`), and the kept `protected-branch-guard` skill says its branch is recorded in `calavera.config.json` (`packages/artifacts/skill-protected-branch-guard/payload/protected-branch-guard/SKILL.md:12`). The tools still run, but people and agents who read those files are pointed at files that no longer exist. These files hold no footprint text, so `eject` does not change them.

The copies of artifact payloads in `.calavera/packages/` are removed, so an installed artifact can no longer be restored or updated through Calavera. The installed copy under `.agents/` stays.

The footprint list in Decision 2 must change whenever Calavera starts writing a new kind of file into projects. #960, which follows this ADR in the same lane (wave 4, column C of the sequencing map), decides whether `artifacts install`, `artifacts update`, and `artifacts status --check-updates` write the `artifact-cache` block themselves or only point to `apply`. Until #960 lands, a project can hold `.calavera/cache/` without the block, so `eject` must handle a cache with no block, and a block with no cache. If #960 makes those commands write the block, the block is recorded in `gitignoreBlocks` and `eject` removes it by the same rule. Any later issue that adds to what Calavera leaves in a project updates Decision 2 in the same pull request. The implementation of #678 can make this a check rather than a rule, for example by keeping the footprint in one list that `eject` and its tests both read; whether to do so belongs to that pull request.

#673 decides whether the bootstrap installs the base skill. If it stops doing so, the skill row in Decision 2 applies only to projects bootstrapped before that change, and `.coderabbit.yaml` is no longer written by the bootstrap alone. #1007 tracks `clean` removing the base skill.

The CLI help text (`index.js:6029-6043`), the README command list, and the bundled skill gain `eject` in the implementation pull request, not in this ADR.

## Alternatives considered

**`clean --all` or `clean --eject`.** Not chosen. `clean` keeps edited items and rewrites the state, and a flag that reversed both would make the two contracts in Decision 1 depend on one option.

**The name `detach`.** The issue offered it. The owner chose `eject` on 2026-11-14.

**Remove the `package.json` scripts that call Calavera.** Not chosen by the owner on 2026-11-14. Calavera did not write those scripts, so removing them would delete the person's own work.

**Remove the installed tooling too.** Out of scope for #678. That is an uninstall: it would remove configuration and development dependencies that the project keeps using after Calavera is gone.

**Keep `.calavera/packages/` and the lock.** Not chosen. Both serve only Calavera's artifact commands, so keeping them leaves management files in a project that no longer uses Calavera.

**Remove the wiring of kept artifacts, or strip its markers.** Not chosen. Removing the wiring would leave the artifacts installed with nothing to run them (Decision 3), and the owner decided on 2026-11-17 that `eject` leaves the markers on the blocks it keeps.

**Delete an edited whole-file `AGENTS.md` after approval.** Not chosen by the owner on 2026-11-17. The file has no section markers, so deleting it would also delete the person's own guidance.

**Let `--yes` remove edited items.** Not chosen by the owner on 2026-11-17. Nobody would have seen the edit before it was removed.
