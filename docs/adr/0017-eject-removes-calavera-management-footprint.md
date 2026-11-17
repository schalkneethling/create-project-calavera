# ADR-0017: `eject` Removes Calavera's Management Footprint and Keeps the Installed Tooling

- **Status:** Proposed (2026-11-17)
- **Date:** 2026-11-17
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/678
- **Decides:** what a new `eject` command removes from a project, what it keeps, and how it asks for approval. `eject` removes the files and the text Calavera keeps in a project to manage it (the footprint): the state, the recipe, the artifact lock and package copies, the artifact cache and its `.gitignore` block, the bootstrap guidance, the MCP setup notes and registration, and the base Calavera skill. It keeps every tool, configuration file, `package.json` entry, and recipe-selected AI artifact that Calavera installed. It changes nothing in `package.json`, and it reports each script there that runs Calavera. Like `apply`, it starts with a dry run, and it deletes nothing until the person approves a list that names every deletion and edit and marks each item the person edited. Decision 8 states how each C8 safety property holds, and Open question 1 asks the owner to confirm the one that this command reads differently from apply.

## Context

The owner asked on 2026-10-09 for a way to stop Calavera managing a project while keeping what it installed. The use case is a template repository that someone scaffolds with Calavera and then does not want Calavera to keep managing (#678).

`clean` does not do this. It removes only stale items, which are managed files, AI artifacts, and wiring that the current recipe no longer selects, and it keeps every item the person edited (`clean` in `packages/cli/src/index.js:5657`). It never removes the state, the recipe, or the bootstrap guidance, and it rewrites `.calavera/state.json` at the end (`index.js:5904`). It can remove the base Calavera skill, though: apply keeps the record of every artifact the recipe does not select (`index.js:3649-3656`, #829), the bootstrap's skill is one of those, and `clean` treats every recorded artifact the recipe does not select as stale (`index.js:5686-5688`). A project may therefore have no base skill by the time it runs `eject`.

The owner settled five points before this ADR, and this ADR does not reopen them:

- **2026-10-09:** the base Calavera skill is part of the footprint and is removed by this command. Whether the bootstrap installs it at all is #673.
- **2026-10-09:** every file the command deletes, including a file the person edited, is listed, and nothing is deleted until the person approves that list. This holds for every destructive action in Calavera.
- **2026-10-09:** a dry run comes first, as with `apply`.
- **2026-11-14:** the command is `eject`.
- **2026-11-14:** `package.json` scripts that call Calavera are reported, not removed.

## What Calavera writes into a project today

This section lists every path Calavera writes, from the code, and says whether Calavera records what it wrote. The record matters because it is the only way a command can tell Calavera's text from an edit.

### Written by the bootstrap (`--init`, also run by `--new`)

`agentBootstrap` (`packages/cli/src/index.js:4142`) writes the following.

- **`.calavera/state.json`**, into which the bootstrap merges the base skill's record, creating the file when it does not exist (`index.js:4186-4189`, `index.js:4227-4230`). The path is `STATE_FILE` (`index.js:324`).
- **The agent guidance**, in one of three forms. When the project has no `AGENTS.md`, it writes the whole file, which starts with `<!-- calavera-agent-bootstrap -->` (`index.js:328`, `index.js:1833`). When `AGENTS.md` exists, the person chooses between a section appended to it, delimited by `<!-- calavera-agent-bootstrap:start -->` and `<!-- calavera-agent-bootstrap:end -->` (`index.js:329-330`, `index.js:3944`), and a separate file, `AGENTS.calavera.md` (`index.js:326`), which the person is told to merge into `AGENTS.md` by hand (`index.js:4238-4241`). A run with `--json` or `--yes`, or without a terminal, takes the separate file (`index.js:3799-3801`).
- **The MCP registration**, for the harness the person chooses: the `calavera` entry under `mcpServers` in `.mcp.json` (Claude Code) or `.cursor/mcp.json` (Cursor), the `[mcp_servers.calavera]` table in `.codex/config.toml` (Codex), or the `calavera` entry under `mcp` in `opencode.json` (OpenCode) (`packages/cli/src/utils/mcp-config.js:135-160`, `:188`, `:292-322`, `:329-344`). Calavera also creates the `mcpServers` or `mcp` object when it is missing, adds `$schema` to `opencode.json` when it has none, and creates `.codex/` or `.cursor/` when the folder is missing. The JSON files are rewritten whole through the project's formatter, and the Codex table is appended after the existing text with its trailing whitespace trimmed. The entry's launch command pins `create-project-calavera@<version>` (`index.js:1874-1880`). A run with `--json` or `--yes`, or without a terminal, skips the registration unless `--mcp-harness` names a harness (`index.js:3833-3835`).
- **`.agents/calavera/mcp.md`**, the manual setup notes, written only when no registration was written (`index.js:4211-4220`).
- **The base Calavera skill**, the artifact `skill-calavera` (`index.js:331-333`, `index.js:342-344`), installed to `.agents/skills/calavera` (`packages/cli/src/ai/artifacts.js:233-235`) and recorded with a hash in the `aiArtifacts` list of the state, like every other AI artifact.
- **`.coderabbit.yaml`**, because installing any skill plans the CodeRabbit path filters (`ai/artifacts.js:502-504`). When the file does not exist, Calavera writes it whole, with a header comment and five filters, including `!.calavera/packages/**` (`ai/artifacts.js:39-67`). When it exists, Calavera adds the missing filters. Neither write is recorded.

Of these, only the skill has a record. The guidance, the setup notes, the MCP registration, and `.coderabbit.yaml` are not recorded in the state (`packages/cli/src/utils/earlier-guidance.js:4-8`). `--init` tells an earlier release's guidance from an edit by comparing the text with digests of what every published release wrote (`earlier-guidance.js:191`). That table covers the whole-file guidance, `AGENTS.calavera.md`, and `mcp.md`. It does not cover the appended section, the MCP entries, or `.coderabbit.yaml`.

### Written by `init`, `apply`, and the artifact commands

- **`calavera.config.json`**, the recipe (`index.js:322`). `init` writes it, `apply` and `apply_recipe` write it when they record an answer the person gave (`index.js:3286-3292`), `--new --config` copies it into the new project (`index.js:4890-4895`), and the person or an agent saves it from the Composer. Calavera keeps no record of its text.
- **`.calavera/state.json`**, which `apply` and `clean` rewrite. It records `integrations`, `files`, `managedFiles` with a hash for each, `aiArtifacts`, `aiWiring`, `gitignoreBlocks`, and `qualityScript` (`packages/cli/src/state.js:24-34`).
- **`.calavera/artifacts.lock.json`**, which records each artifact package's version, integrity, and `payloadHash` (`packages/cli/src/artifact-lifecycle.js:30`, `:58`).
- **`.calavera/packages/`**, the extracted package payloads that installs copy from (`artifact-lifecycle.js:34`, `:357`).
- **`.calavera/cache/`**, the npm download cache (`artifact-lifecycle.js:32-33`), and the `artifact-cache` block in `.gitignore` that keeps it out of Git (`artifact-lifecycle.js:41`, ADR-0016 Amendment 1). The block is recorded in `gitignoreBlocks`. Until #960 lands, the `artifacts` commands can create the cache without the block.
- **`.calavera/.staging/`, `.calavera/.transactions/`, and `.calavera/artifact-transaction.json`**, which exist only while an artifact operation runs, or after one was interrupted (`artifact-lifecycle.js:35-36`, `:365`). The journal file means a rollback is still pending. Every `artifacts` command recovers it first (`artifact-lifecycle.js:110`), and a dry run refuses while it exists (`artifact-lifecycle.js:885-889`).
- **Managed files**, such as `.editorconfig`, `knip.json`, `.htmlvalidateignore`, `scripts/lint-html.mjs`, and `scripts/repository-controls.mjs`, each recorded with a hash in `managedFiles`.
- **`package.json` scripts and development dependencies.** The scripts Calavera generates run the tools and the managed scripts, such as `knip`, `stryker run`, and `node scripts/lint-html.mjs` (`buildScripts`, `index.js:1620-1781`). None of them runs Calavera itself. The only state record about `package.json` is `qualityScript` (#230).
- **Recipe-selected AI artifacts** under `.agents/skills/`, `.agents/hooks/`, `.agents/agents/`, and `.codex/agents/` (`ai/artifacts.js:233-251`), each recorded with a hash in `aiArtifacts`. `skill-calavera` is also a cataloged artifact that a recipe can select (`packages/artifact-core/src/catalog.js:29`).
- **Their wiring**: a marked block in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and matcher groups in `.claude/settings.json`, recorded in `aiWiring` (ADR-0015, Decision 5).
- **Integration blocks in `.gitignore`**, one marked block per integration that declares ignore lines, recorded in `gitignoreBlocks` (ADR-0016), and Varlock's unmarked section, which has no record (`index.js:2186`).

## Decision

### 1. The command is `eject`, a separate command from `clean`

`create-project-calavera eject` is a new top-level command. It is not a flag on `clean`, because the two commands have opposite contracts:

| Question                                   | `clean`                                            | `eject`                                       |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------- |
| Which items does it consider?              | Items the recipe no longer selects                 | Calavera's own footprint, selected or not     |
| What happens to an item the person edited? | Kept and reported as a skip                        | Listed, marked as edited, removed on approval |
| Does Calavera keep managing the project?   | Yes, and the state file is rewritten               | No, and the state file is removed             |
| What happens to installed tooling?         | Removes stale managed files, artifacts, and wiring | Keeps every tool, file, artifact, and wiring  |

`eject` reuses the existing checks rather than adding parallel ones: `hashAiInstall` (`ai/artifacts.js:348`) for the base skill, `findEarlierGuidance` for the guidance files, the marker helpers in `packages/cli/src/utils/marked-block.js` and the record rule of ADR-0016 Decision 4 for the `artifact-cache` block, and `utils/json-rewrite.js`, which reports a JSON rewrite that would lose what the person wrote, for the MCP files. `planGitignoreBlocks` (`packages/cli/src/ignore-lines.js:91`) cannot be reused as it is, because it removes a block only through a state record (`ignore-lines.js:113-138`), and `eject` must also handle a project whose state file is gone.

`eject` is a CLI command only and is not offered as an MCP tool. It removes the Calavera MCP registration, so an agent that ran `eject` through the Calavera MCP server would remove that server's registration during the session. The owner's approval rule also asks for the person to approve the list, which the CLI prompt does directly.

### 2. What `eject` removes

| Item                                                                              | Record today               | How `eject` tells an edit                                                           |
| --------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `.calavera/state.json`                                                            | It is the record           | Not applicable                                                                      |
| `calavera.config.json`                                                            | None                       | Open question 2                                                                     |
| `.calavera/artifacts.lock.json`                                                   | It is a record             | Not applicable                                                                      |
| `.calavera/packages/`                                                             | `payloadHash` in the lock  | Each payload's hash against the lock                                                |
| `.calavera/cache/`                                                                | None; local download cache | Not applicable                                                                      |
| `.calavera/.staging/` and `.calavera/.transactions/`, when no rollback is pending | None; transient            | Not applicable                                                                      |
| The `artifact-cache` block in `.gitignore`                                        | `gitignoreBlocks`          | The block's lines against the record (ADR-0016, Decision 4); Open question 6        |
| `AGENTS.md` written as a whole file                                               | None                       | The text against the current guidance and `findEarlierGuidance`; Open question 3    |
| The marked section in an existing `AGENTS.md`                                     | None                       | The section against the current section text; Open question 4                       |
| `AGENTS.calavera.md`                                                              | None                       | The text against the current guidance and `findEarlierGuidance`                     |
| `.agents/calavera/mcp.md`                                                         | None                       | The text against the current notes and `findEarlierGuidance`                        |
| The `calavera` MCP entry in each of the four harness files                        | None                       | Open question 5                                                                     |
| `.agents/skills/calavera`, when no recipe selects `skill-calavera`                | `aiArtifacts`, with a hash | `hashAiInstall` against the record; Open question 7 covers a recipe that selects it |

For a whole file, "remove" means delete it. For the `AGENTS.md` section, the `.gitignore` block, and an MCP entry, "remove" means delete only Calavera's text, markers included, and the blank-line separator Calavera added before it. Every other line or key stays. Calavera cannot always restore the file byte for byte: the append trimmed the person's trailing whitespace before adding the section or the Codex table (`index.js:3948-3951`, `utils/mcp-config.js:245-251`), and the JSON harness files are rewritten whole through the formatter. The dry run shows the resulting text, so the approval covers it.

A footprint item that is already gone counts as removed, which covers a base skill that `clean` already removed. `eject` removes `.calavera/` and `.agents/calavera/` when it has emptied them. It keeps either folder when it still holds a file `eject` does not name, and lists those files, because it removes only what it can name in the dry run. Every other folder or file that `eject` leaves empty, such as a `.gitignore` that held only the cache block, stays in place, as ADR-0015 and ADR-0016 leave an emptied hook script, settings file, or `.gitignore`. Open question 5 asks whether an emptied MCP file follows that precedent.

`eject` looks for each item directly, not only through the state file. The guidance and MCP entries have no record, and a project whose state file the person already deleted still holds the rest of the footprint. Guidance that the person merged from `AGENTS.calavera.md` into `AGENTS.md` has no section markers, so `eject` can find it only by the `<!-- calavera-agent-bootstrap -->` marker, when the merge kept it. Open question 4 covers that case.

### 3. What `eject` keeps

`eject` keeps, without changing them, every managed file, every `package.json` script and dependency, every recipe-selected AI artifact and its wiring in `.vite-hooks/` and `.claude/settings.json`, every integration block in `.gitignore`, and Varlock's section in `.gitignore`. Removing any of these is an uninstall, which #678 puts out of scope. What happens to `.coderabbit.yaml` is Open question 10.

The wiring stays because it runs the artifacts that stay. Removing the `protected-branch-guard` blocks, for example, would leave the guard installed with nothing to run it, which ADR-0015 Decision 4 calls a failure. Whether `eject` should strip Calavera's marker comments from the blocks it keeps is Open question 8.

### 4. Scripts that call Calavera are reported

`eject` writes nothing to `package.json` (owner decision, 2026-11-14). It reads every script and reports each one whose value runs a `create-project-calavera` or `create-project-calavera-mcp` executable, the two `bin` entries of the package (`packages/cli/package.json:28-31`), whether directly or through a package runner. The report names the script and its value and says that the script stops working once Calavera is gone, so the person can change or remove it.

Because Calavera's generated scripts never run Calavera (`index.js:1620-1781`), every reported script is one that the person or another tool added. Whether a `create-project-calavera` development dependency is also reported is Open question 9.

### 5. The dry run and the approval

`eject --dry-run` lists every file and directory `eject` would delete, every edit it would make with the exact text it removes and the text the file holds afterward, every file it would keep in a folder it cannot empty, and every reported script. It changes nothing.

`eject` without `--dry-run` shows the same list, marks each item the person edited since Calavera wrote it, and asks for approval. It deletes nothing until the person approves the whole list, and declining cancels the run with nothing changed. An edited item is removed after approval, as the owner decided on 2026-10-09. An item whose edit `eject` cannot detect, because Calavera has no record of it, says so in the list rather than appearing unedited.

A run that cannot ask, because of `--json` or no terminal, refuses unless `--yes` is given, writes nothing, and prints the list. `--yes` is the existing confirmation flag (`index.js:1300`), and `--new` already uses it to confirm a run that cannot ask (`index.js:4780`). With `--yes`, the run prints the list it acts on. That list is not tied to an earlier dry run, so the project can change between the preview and the run. Whether that is enough to meet "nothing is deleted until the person approves that list" is Open question 11.

### 6. The order of the writes

`eject` deletes `.calavera/cache/` before it removes the `artifact-cache` block, so a run that stops between the two never shows the cache in `git status`. It then removes Calavera's text from the other shared files, deletes the remaining footprint files and folders, and deletes `.calavera/state.json` last. A run that stops partway therefore leaves the state file, and the next `eject` finds the rest of the footprint and continues.

`eject` stops before it writes or deletes anything when it cannot plan safely: when a marker in `AGENTS.md` or `.gitignore` is unpaired or changed, when an MCP harness file cannot be parsed, or when `.calavera/artifact-transaction.json` shows an interrupted artifact operation whose rollback is still pending. Each stop names the file and the remedy. Whether `eject` recovers a pending transaction itself, as every `artifacts` command does, or stops and points to one of those commands is Open question 12.

### 7. A second run reports nothing to do

When no footprint item from Decision 2 exists, `eject` reports that it found nothing to remove and exits successfully. Scripts that still call Calavera are reported on every run, because they remain until the person changes them, but they do not count as work for `eject`. Some answers to Open questions 3 and 6 would keep an edited footprint item. Those items would need the same treatment as scripts, reported but not counted as work, for the issue's acceptance criteria "no Calavera state, recipe, guidance … remains" and "a second run reports nothing to do" to hold.

### 8. How C8 holds

No C8 test changes.

- **Only the CLI writes into projects.** `eject` is a CLI command, and nothing asks the person or an agent to edit a file.
- **The dry run is the approval boundary.** `dry_run_apply` is the boundary for apply. `eject` keeps a boundary of the same kind for itself: its dry run lists every deletion and edit, with the text, and an interactive run removes nothing the list it shows does not name. Open question 11 covers `--yes`.
- **Local edits are preserved and never overwritten.** `eject` keeps every line and key outside Calavera's markers and entries. It deletes an edited footprint item only after the person approves a list that marks the item as edited, which is the owner's 2026-10-09 rule for destructive actions. Open question 1 asks the owner to confirm that this rule and C8 agree.
- **Artifacts are not recorded in `package.json`.** `eject` writes nothing to `package.json`.
- **Conflicts surface as a hard stop.** The cases in Decision 6 stop `eject` before it writes or deletes anything.

## Consequences

A project that runs `eject` keeps working with its tools: `vp check`, the generated scripts, and the installed artifacts run as before, because nothing they read is removed. Commands that need Calavera, such as `apply`, `doctor`, and `artifacts update`, no longer have a state or a recipe to work from. Running `--init` and `apply` again would start management over.

Some kept files still describe Calavera after `eject`. The managed `docs/repository-controls.md` tells the reader to edit the Calavera recipe and apply it again (`packages/cli/src/github-repository-controls.js:157`), and the kept `protected-branch-guard` skill says its branch is recorded in `calavera.config.json` (`packages/artifacts/skill-protected-branch-guard/payload/protected-branch-guard/SKILL.md:12`). The tools still run, but people and agents who read those files are pointed at files that no longer exist. The implementation reports these files, so the person can edit them.

The copies of artifact payloads in `.calavera/packages/` are removed, so an installed artifact can no longer be restored or updated through Calavera. The installed copy under `.agents/` stays.

The footprint list in Decision 2 must change whenever Calavera starts writing a new kind of file into projects. #960, which follows this ADR in the same lane (wave 4, column C of the sequencing map), decides whether `artifacts install`, `artifacts update`, and `artifacts status --check-updates` write the `artifact-cache` block themselves or only point to `apply`. Until #960 lands, a project can hold `.calavera/cache/` without the block, so `eject` must handle a cache with no block, and a block with no cache. If #960 makes those commands write the block, the block is recorded in `gitignoreBlocks` and `eject` removes it by the same rule. Any later issue that adds to what Calavera leaves in a project updates Decision 2 in the same pull request. The implementation of #678 can make this a check rather than a rule, for example by keeping the footprint in one list that `eject` and its tests both read; whether to do so belongs to that pull request.

#673 decides whether the bootstrap installs the base skill. If it stops doing so, the skill row in Decision 2 applies only to projects bootstrapped before that change, and `.coderabbit.yaml` is no longer written by the bootstrap alone.

The CLI help text (`index.js:6029-6043`), the README command list, and the bundled skill gain `eject` in the implementation pull request, not in this ADR.

## Alternatives considered

**`clean --all` or `clean --eject`.** Not chosen. `clean` keeps edited items and rewrites the state, and a flag that reversed both would make the two contracts in Decision 1 depend on one option.

**The name `detach`.** The issue offered it. The owner chose `eject` on 2026-11-14.

**Remove the `package.json` scripts that call Calavera.** Not chosen by the owner on 2026-11-14. Calavera did not write those scripts, so removing them would delete the person's own work.

**Remove the installed tooling too.** Out of scope for #678. That is an uninstall: it would remove configuration and development dependencies that the project keeps using after Calavera is gone.

**Keep `.calavera/packages/` and the lock.** Not chosen. Both serve only Calavera's artifact commands, so keeping them leaves management files in a project that no longer uses Calavera.

**Remove the wiring of kept artifacts.** Not chosen. The artifacts would stay installed with nothing to run them (Decision 3).

## Open questions

These are for the owner to decide, in review of this ADR or on #678 before implementation.

1. **C8 and edited files.** C8 says local edits are preserved and never overwritten. The owner's 2026-10-09 rule lets `eject` delete an edited footprint item after the person approves a list that marks it as edited. This ADR reads the two as compatible, because no edit is removed without the person seeing and approving it, and therefore changes no C8 test. Does the owner confirm that reading, or does it need a decision issue?
2. **The recipe has no record.** Calavera cannot tell whether the person edited `calavera.config.json`, because several writers produce it and no hash is kept. Is it listed as "the project's recipe, edits not detectable", or does `eject` compare it with something?
3. **A whole-file `AGENTS.md` that the person extended.** The whole-file guidance has no section markers, so `eject` cannot separate Calavera's text from the person's. Under the 2026-10-09 rule, an edited file is deleted after approval, which here would delete the person's own guidance with it. Is that intended, or does `eject` keep an edited whole-file `AGENTS.md` and report it (see Decision 7)?
4. **Guidance without section markers.** The current section text is known, but earlier releases' section texts are not in the `findEarlierGuidance` table, so a section from an older release looks edited. Guidance merged by hand from `AGENTS.calavera.md` has no section markers at all. Does the table gain section digests first, and does `eject` look for merged guidance by its `<!-- calavera-agent-bootstrap -->` marker, or report that it cannot find it?
5. **MCP entries with no record.** The bootstrap records neither the harness nor the entry. Does `eject` treat a `calavera` entry as Calavera's whatever its value, compare it with the launch command for each package manager with the pinned version normalized as `findEarlierGuidance` does for `mcp.md`, or report a differing entry as edited? Does it also remove the `mcpServers` or `mcp` object and the `$schema` it added when nothing else remains in them? And when the file is left with no content of the person's, is it deleted, or left in place as ADR-0015 leaves an emptied hook script or `.claude/settings.json`?
6. **An edited `artifact-cache` block.** ADR-0016 makes an edited block a hard stop for apply. Does `eject` keep that hard stop, or list the block as edited and remove it after approval, like a file?
7. **A recipe that selects `skill-calavera`.** Then `.agents/skills/calavera` is both the base skill, which the 2026-10-09 rule removes, and a recipe-selected artifact, which Decision 3 keeps, with a lock entry and a payload in `.calavera/packages/`. Which rule wins?
8. **Markers on kept blocks.** The integration blocks in `.gitignore` and the wiring blocks in `.vite-hooks/` keep their `calavera:<id>` markers after `eject`. Are the markers stripped, leaving the lines as the person's own, or left as they are?
9. **A `create-project-calavera` development dependency.** Scripts are reported (Decision 4). Is a development dependency on the package also reported, or left without a mention?
10. **`.coderabbit.yaml`.** When the bootstrap or apply created the file whole because a skill was installed, is it part of the footprint? When the file existed before, does `eject` report the `!.calavera/packages/**` filter, remove that one line, or leave it without a mention?
11. **`--yes` and approval.** A `--yes` run acts on a list nobody saw before it ran, and nothing ties it to an earlier dry run. Is printing the list enough, or does a non-interactive run need a token from the dry run, as apply passes the dry run's recipe to `apply_recipe` (ADR-0015, Decision 6 amendment of 2026-10-31)?
12. **A pending artifact transaction.** Every `artifacts` command already recovers a pending transaction before it runs (`artifact-lifecycle.js:110`). Does `eject` recover it the same way before planning, or stop and tell the person to run an `artifacts` command first?
13. **Workspaces.** Calavera's paths are relative to the directory it runs in, as `clean`'s are. In a workspace where the bootstrap ran at the root and apply ran in a package, or the reverse, does `eject` remove only the footprint in the current directory and name the other location, or look for both?
