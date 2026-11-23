# ADR-0022: Require OpenCode 2 and Write Its MCP Layout

- **Status:** Proposed
- **Date:** 2026-11-23
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/1204
- **Decides:** Calavera requires OpenCode 2 and drops OpenCode 1.x support. `--init` writes the `calavera` entry in `opencode.json` under `mcp.servers`, the layout OpenCode 2 documents, with no `enabled` or `disabled` field. An unedited entry that an earlier release wrote directly under `mcp` moves to `mcp.servers`. An edited entry is never rewritten: `--init` leaves `opencode.json` unchanged and reports the entry with a remedy, and the rest of `--init` continues. `eject` recognizes the new entry and the entry that every earlier release wrote as unedited, and keeps and reports an edited one. When `opencode` is on the `PATH`, `--init` runs `opencode --version` and warns about an OpenCode version below 2 before it writes, without ever blocking the write. No flag, setting, or deprecated path writes the OpenCode 1.x layout. The owner decided the direction on 2026-11-23 (https://github.com/schalkneethling/create-project-calavera/issues/1089, owner comment of that date), and answered the open questions of the first draft the same day (https://github.com/schalkneethling/create-project-calavera/issues/1204#issuecomment-7097357478); each answer is recorded under "Owner decisions". This document changes no code. The issue's scope puts the ADR and the removal in one pull request; this ADR was proposed on its own first so that the owner could answer its open questions before the code changes, and the implementation pull request closes #1204.

## Context

#1089 asked whether the bootstrap writes MCP entries in the shapes that OpenCode and Cursor document today. PR #1200 shipped the Cursor half: `.cursor/mcp.json` now carries `"type": "stdio"`. The OpenCode half differs in kind, because OpenCode 2 moved MCP servers to a new place in `opencode.json`, and OpenCode's migration guide warns against pointing OpenCode 1.x at files in the new layout. Writing the new layout therefore means dropping OpenCode 1.x, which makes it a removal. The repository rules call for one pull request and one ADR per removal, with no deprecated paths, flags, or legacy modes left behind.

#1205 is in progress and changes the same entries. It makes a rerun of `--init` leave an edited `calavera` MCP entry alone, in every harness file, instead of overwriting it as today. This ADR applies the same rule to the OpenCode migration and names the one function both changes share (Decision 7).

## What exists today

### What the bootstrap writes

`--init` asks for one MCP host (`--mcp-harness claude-code|codex|cursor|opencode|skip`). For OpenCode, `writeOpenCodeMcpConfig` (`packages/cli/src/utils/mcp-config.js`, lines 317 to 346) reads the project's `opencode.json`, sets `$schema` to `https://opencode.ai/config.json` when the file holds no string `$schema`, and sets `mcp.calavera`, overwriting any entry already there:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "calavera": {
      "type": "local",
      "command": [
        "npx",
        "--package",
        "create-project-calavera@<version>",
        "create-project-calavera-mcp"
      ],
      "enabled": true
    }
  }
}
```

The first element of `command` and the arguments before `--package` depend on the package manager: `npx`, `pnpm dlx`, `yarn dlx`, or `bunx` (`createPackageRunnerCommand`, `packages/cli/src/index.js`, lines 2117 to 2128). The setup notes in `.agents/calavera/mcp.md` show the same entry, built by the same function (`index.js`, line 2195).

Every release that offers OpenCode wrote this one shape. The writer itself shows it: `mcp-config.js` at the tags `v2.2.0` (under `src/utils/`), and `v3.0.0`, `v5.0.0`, and `v6.0.0` (under `packages/cli/src/utils/`), writes the same `type`, `command`, and `enabled: true`, and the writer did not exist at `v2.1.2`. The setup notes templates in `packages/cli/fixtures/agent-guidance/mcp/` record what each release wrote: the OpenCode block first appears in the `2.2.0` template, and its JSON is identical, apart from the pinned version, in every template from `2.2.0` through the unreleased `6.3.0`, for all four package managers. The `2.1.2` and earlier templates have no OpenCode block. The released version is 6.2.1.

### What `eject` matches

`planJsonMcpEntry` (`packages/cli/src/eject.js`) looks for `calavera` directly under `mcp` in `opencode.json`. The entry is unedited when it equals the entry Calavera writes for some package manager, with the pinned version normalized (owner decision of 2026-11-17 on #678). An edited entry is kept and reported (ADR-0017, Decisions 2 and 6). `eject` does not look under `mcp.servers` today.

### What happens when a write fails

`writeAgentBootstrapMcpConfig` (`index.js`, lines 4411 to 4467) turns an error from any harness writer into a `manual` result: it discards the pending changes for that file, and the summary prints "Could not write project MCP config at <path>: <reason>" followed by the manual setup instructions. The rest of `--init` continues.

## What OpenCode documents today

The MCP servers page (https://opencode.ai/docs/mcp-servers/), section "Config", says: "To configure a server by hand, give it a unique name under `mcp.servers`. V2 does not place server names directly under `mcp`." It also says that "Servers connect automatically", and to "Use `disabled`, not an `enabled` field, to keep one configured without connecting it". The section "Local" lists `type` (required, "Must be `"local"`") and `command` (required, "Executable followed by its arguments") among the fields of a local server, and gives `disabled` the default `false`.

The schema (https://opencode.ai/config.json, read on 2026-11-23) declares two named members of `mcp`: `servers` and `timeout`. A local server under `mcp.servers` (`Mcp.LocalConfigEncoded`) requires `type` and `command`, allows `disabled`, has no `enabled` property, and sets `additionalProperties` to `false`. Any other member of `mcp` is matched by an `additionalProperties` schema marked `"deprecated": true`: it must be a local server (`McpLocalConfig`, which has `enabled` and no `disabled`), a remote server, or an object that holds only `enabled`. That deprecated schema describes the layout that OpenCode 1.x reads.

The migration guide (https://opencode.ai/docs/migrate-v1/), section "Configuration", subsection "MCP servers", says: "V2 groups servers under `mcp.servers`, replaces `enabled` with the inverse `disabled`, and separates timeout purposes". The subsection "Ask OpenCode to migrate" says that "The V1 config format remains supported" and that "OpenCode recognizes mixed V1 and V2 members within `mcp`, …". The section "Install V2" says: "V1 and V2 use the same configuration locations, so do not point V1 at files after converting them to native V2-only shapes." The guide does not say what OpenCode 1.x does when it reads the new layout.

Two facts follow. OpenCode 2 still reads the entry that Calavera writes today, so the current entry is deprecated, not broken. And an entry under `mcp.servers` must not carry `enabled`, because the schema for that location forbids any property it does not list.

## Decision

### 1. Calavera requires OpenCode 2 and writes `mcp.servers.calavera`

`--init` writes the `calavera` entry under `mcp.servers`, with `type` and `command` only:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "calavera": {
        "type": "local",
        "command": [
          "npx",
          "--package",
          "create-project-calavera@<version>",
          "create-project-calavera-mcp"
        ]
      }
    }
  }
}
```

Calavera writes no `disabled` field, because OpenCode connects a server by default and `disabled` defaults to `false`. The `command` array and the `$schema` handling do not change. The setup notes, the README, and `docs/agent-first-calavera-workflow.md` show this shape and say that OpenCode 2 is required.

### 2. What `--init` does with each state of `opencode.json`

"Unedited" means equal, with the pinned version normalized, to the entry some release wrote at that location for some package manager; Decision 7 names the function that decides it. "Edited" means any other value. Every case that leaves the file unchanged reports the result as `manual`, which is today's outcome for a failed MCP write (Context), and the rest of `--init` continues.

| What `opencode.json` holds                                                                                                            | What `--init` does                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `calavera` entry                                                                                                                   | Writes `mcp.servers.calavera`.                                                                                                                                                                      |
| An unedited entry directly under `mcp`, and none under `mcp.servers`                                                                  | Removes `mcp.calavera` and writes `mcp.servers.calavera`, in one write, and reports the move (Decision 5).                                                                                          |
| An unedited entry under `mcp.servers`                                                                                                 | Updates it to the current version.                                                                                                                                                                  |
| Unedited entries in both places                                                                                                       | Removes `mcp.calavera` and updates `mcp.servers.calavera`, in one write, and reports the move.                                                                                                      |
| An edited entry in either place, whatever the other place holds                                                                       | Leaves the whole file unchanged and names each edited entry by its location, with the remedy below.                                                                                                 |
| An `mcp.servers` that is not the OpenCode 2 container (Decision 3)                                                                    | Leaves the whole file unchanged, with the remedy from Decision 3.                                                                                                                                   |
| A file with comments (JSON with comments, JSONC), which OpenCode's schema allows (`"allowComments": true`)                            | Leaves the whole file unchanged, and says that Calavera does not rewrite a file with comments, because the comments would be lost, and that the person can move the entry to `mcp.servers` by hand. |
| Any other shape Calavera cannot read: a top level, an `mcp`, or a `calavera` entry that is not an object, or JSON that does not parse | Leaves the whole file unchanged, with today's message for that shape.                                                                                                                               |

For an edited entry directly under `mcp`, the remedy reads: "opencode.json holds a calavera entry directly under mcp that differs from the entry Calavera wrote, so Calavera leaves the file unchanged. OpenCode 2 reads servers from mcp.servers: move the entry there and replace enabled with disabled, as OpenCode's migration guide describes, or remove it, then run --init again." When that entry holds only `enabled`, the 1.x way to switch off a server configured elsewhere, the remedy instead says to remove it, or to set `"disabled": true` on the full entry under `mcp.servers`, because an entry under `mcp.servers` needs `type` and `command`. For an edited entry under `mcp.servers`, the message is the one #1205 writes for every harness (Decision 7). Each message names the file and the location, never the entry's value, which can hold an `environment` with secrets.

Today `--init` reads a file with comments as JSON that does not parse, and its message asks the person to correct the JSON. That message is wrong for a valid OpenCode file; the JSONC row above replaces it for `opencode.json`.

The file stays unchanged when any entry is edited, because C8 forbids rewriting the edited entry, and a partial write would leave the person with two `calavera` entries to untangle. The migration guide does not say how OpenCode 2 resolves a server that appears both directly under `mcp` and under `mcp.servers`, so this ADR does not rely on either outcome.

### 3. What `mcp.servers` must hold to be the OpenCode 2 container

In the OpenCode 1.x layout, every member of `mcp` is a server, so a person may have a server named `servers`. OpenCode 2 reserves that name for the object that holds servers. One rule decides which reading applies, in `--init` and in `eject` alike: `mcp.servers` is the OpenCode 2 container exactly when it is an object whose every member is an object. A server in either layout is an object whose `type` is a string and whose `command` is an array, so an OpenCode 1.x server named `servers` always fails the rule, while an OpenCode 2 container that holds a server named `type` passes it.

When `mcp.servers` fails the rule, `--init` leaves the file unchanged and reports one of three messages:

- When its `type` member is a string, it is an OpenCode 1.x server: "opencode.json holds a server named servers directly under mcp, a name OpenCode 2 reserves for the object that holds servers. Rename that server, then run --init again."
- When `enabled` is its only member, it is an OpenCode 1.x switch for a server named `servers`: the message says to rename or remove it.
- Otherwise: "opencode.json holds an mcp.servers member that is not an object of servers. Correct it as OpenCode's MCP documentation describes, then run --init again."

`eject` does not search an `mcp.servers` that fails the rule for `calavera`. The saved patch writes `calavera` into such a server, which corrupts it; the implementation fixes that first, with a test. `servers` is the only reserved key that Calavera writes into; `timeout` is also reserved by OpenCode 2 and is left as it is.

### 4. What `eject` recognizes

`eject` looks for `calavera` in two places in `opencode.json`:

| Location      | Unedited when it equals, with the pin normalized, for some package manager | Written by          |
| ------------- | -------------------------------------------------------------------------- | ------------------- |
| `mcp.servers` | `{ "type": "local", "command": [ … ] }`                                    | This change onward  |
| `mcp`         | `{ "type": "local", "command": [ … ], "enabled": true }`                   | 2.2.0 through 6.2.1 |

Because every release from 2.2.0 through 6.2.1 wrote the second shape, and the runner arguments have not changed in that time (Context), these two shapes cover every entry a release wrote. When the file holds an entry in both places, `eject` removes them together, or keeps both when either is edited and reports every edited location. Removing an entry can empty `mcp.servers`, and then `mcp`; each emptied object goes too, and the `$schema` Calavera writes goes once nothing else remains, as ADR-0017, Decision 2, already specifies for `mcp`. The rule for a file with comments, from the owner decision of 2026-11-19 on #678, is unchanged: `eject` never rewrites such a file, and reports an entry found in either place.

### 5. What an OpenCode 1.x user sees

A person on OpenCode 1.x meets the change in one of three ways. When the `opencode` on their `PATH` is a 1.x release, `--init` also warns them before it writes (Decision 6).

- **A new setup.** `--init` writes `mcp.servers.calavera`. OpenCode 1.x reads every member of `mcp` as a server, so it reads a server named `servers` whose value is `{ "calavera": { … } }`. That value has no `type` and holds a key other than `enabled`, so it matches none of the shapes that OpenCode 2's schema allows for the deprecated layout. The expected result is that OpenCode 1.x rejects `opencode.json` as invalid, or at least does not start Calavera's server. This is derived from OpenCode 2's description of the old layout, not from OpenCode 1.x itself; the implementation confirms it (owner decision 5).
- **A rerun of `--init` on a project that an earlier release set up.** The unedited entry moves to `mcp.servers`, and the person sees the same result as a new setup. The summary names the move under `opencode.json`: "Moved the calavera entry from mcp to mcp.servers, the layout OpenCode 2 reads. OpenCode's migration guide says not to point OpenCode 1.x at files in this layout: install OpenCode 2, or restore opencode.json from version control." The `--json` result carries the same text in the `reason` field of the `update` result, which today appears only on a `manual` result (`index.js`, lines 4411 to 4467), so an agent reading `--json` learns of the move too.
- **No rerun.** Nothing changes. The entry an earlier release wrote keeps working in OpenCode 1.x, and in OpenCode 2 as a deprecated member.

The README and the setup notes state the requirement next to the OpenCode example: "Calavera requires OpenCode 2. OpenCode's migration guide says not to point OpenCode 1.x at files in the `mcp.servers` layout." The changeset says the same.

### 6. Detecting OpenCode 1.x

When the person chooses OpenCode as the MCP host, `--init` checks which OpenCode is on their `PATH` once, before it writes `opencode.json`, and warns when it is older than OpenCode 2 (owner decision 2). The check only informs. It never blocks or changes the write, it never chooses the layout, and it runs the same way under `--dry-run`, because it writes nothing. A missing `opencode`, a failing one, or output Calavera cannot read changes nothing and is not an error.

#### What `opencode --version` prints

Both major versions print the version on standard output and exit, but in different forms, so the parser accepts both. This was read from OpenCode's source (https://github.com/anomalyco/opencode) on 2026-11-23, not from a running binary:

| Release line | Where the version comes from                                                                                                                                                                                                                                                                                                                                                                         | Output                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1.x          | At tag `v1.19.6`, `packages/opencode/src/index.ts` declares `.version("version", "show version number", InstallationVersion)` with yargs 18.0.0, which prints the value alone through its logger (`build/lib/usage.js`, `showVersion`). `InstallationVersion` is the build's `OPENCODE_VERSION`, or `local` in a build without one (`packages/core/src/installation/version.ts`).                    | `1.19.6`                                             |
| 2.x          | At tag `v2.4.0`, `packages/cli/src/index.ts` passes `OPENCODE_VERSION` to Effect 4.1.0's `Command.run`. Effect's built-in `--version` flag (`effect/src/cli/GlobalFlag.ts`, `Version`) prints `formatVersion(name, version)`, which is `${bold(name)} ${dim("v")}${bold(version)}` (`effect/src/cli/CliOutput.ts`). The root command's name is `opencode` (`packages/cli/src/commands/commands.ts`). | `opencode v2.4.0`, with color codes when color is on |

Effect turns color off when `NO_COLOR` is set to a non-empty value, which wins over `FORCE_COLOR` (`effect/src/cli/TerminalCapabilities.ts`), so Calavera sets `NO_COLOR=1` for the child process and still strips ANSI escape sequences in case a build ignores it.

#### How the version is parsed

Calavera reads standard output only, removes ANSI escape sequences, and takes the first non-empty line, trimmed. It accepts that line when it matches `^(?:\S+\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$`, which covers both forms above, a build whose root command has another name (`packages/cli/src/commands/commands.ts` takes it from `OPENCODE_CLI_NAME` when the build sets one), and prerelease or build suffixes. Calavera warns when the major version is below 2, which covers 1.x and the earlier 0.x releases. A major version of 2 or higher, a line that does not match, such as `local`, empty output, or a nonzero exit, gives no warning. Calavera never prints the child's standard error, and never prints its standard output as it came: the warning names only the version that the expression captured, rebuilt from its digits and suffix.

#### How the command runs

- **No shell.** Calavera runs the command with `execFile("opencode", ["--version"])`, as `packages/cli/src/utils/default-branch.js` already runs `git`, so no shell parses a command line. Node looks `opencode` up on the `PATH` itself, and an `ENOENT` error means that OpenCode is not installed, which gives no warning. On Windows, Node cannot run a `.cmd` shim without a shell, so an `opencode.cmd` installed by a package manager is not run, and the check gives no warning there.
- **A timeout.** The child process gets 5 seconds, a 64 KiB output limit, and `windowsHide: true`. On a timeout, Node stops the process with `SIGTERM` and Calavera gives no warning. OpenCode 2 builds its configuration and plugin runtime before it handles `--version` (`packages/cli/src/index.ts` at `v2.4.0`), so it starts more slowly than a plain binary; 5 seconds leaves room for that without making `--init` wait long.
- **A neutral working folder.** The child process runs in the operating system's temporary folder, not in the project, because OpenCode 2 loads its configuration layer at startup, and Calavera does not need it to read the project's `opencode.json` or plugins to print a version.
- **The environment.** The child process gets the person's environment plus `NO_COLOR=1`. Calavera does not log the environment.

#### What the warning says

The warning appears in the summary under `opencode.json`, before the write's own line, and in `--json` as a `warning` field on the OpenCode MCP result:

> OpenCode 1.19.6 is on your PATH. Calavera writes opencode.json in the OpenCode 2 layout (mcp.servers), and OpenCode's migration guide says not to point OpenCode 1.x at files in that layout. Upgrade OpenCode to version 2 (https://opencode.ai/docs/migrate-v1/), then start OpenCode in this project.

The write goes ahead in every case, so the warning and the move message of Decision 5 can appear together.

#### How it is tested without the binary

The tests put a stub executable named `opencode`, a Node script with a `#!/usr/bin/env node` line, in a new folder first on `PATH`, as `check-config-schema.test.mjs` already does for `npm`. The stub prints what the test chooses and exits with the code the test chooses. The cases are:

- The stub prints `1.19.6`, and the warning names 1.19.6, while `opencode.json` is still written in the OpenCode 2 layout.
- The stub prints `opencode v2.4.0`, or the same text with ANSI color codes, and no warning appears.
- The stub prints `0.15.0`, and the warning appears.
- The stub prints `local`, prints nothing, or exits with code 1, and no warning appears.
- The stub sleeps past a timeout that the test shortens through an internal option, and no warning appears, and `--init` finishes.
- `PATH` holds only an empty folder, and no warning appears.
- The stub writes a marker string to standard error, and the marker appears in no output.
- The stub writes its working folder and the value of `NO_COLOR` to a file, so the test can assert the temporary folder and `NO_COLOR=1`.
- A harness other than OpenCode never runs the stub.

Each check is proved by a test that fails when the check is removed. The stub tests run on POSIX systems; on Windows they are skipped, because a script stub there would itself need a `.cmd` shim.

### 7. One matching function and one list of locations

`--init` (Decision 2) and `eject` (Decision 4) decide "unedited" with one function, `matchesMcpEntry` in `packages/cli/src/utils/mcp-config.js`, which the saved patch introduces. It compares an entry with the list of entries Calavera writes at that location, with the pinned version normalized, and an entry that holds the version placeholder matches none. The saved patch still builds the pairing of each location with its expected entries twice, once in `writeOpenCodeMcpConfig` and once in `eject`'s `planMcpEntries`, and takes the launch commands from two call sites. The implementation adds one exported list in `mcp-config.js`, `openCodeMcpLocations(launchCommands)`, that returns each location with its expected entries, and both commands read it, so a future change to an entry updates `--init` and `eject` together.

#1205 adds the edited check for `mcp.servers.calavera`, as part of the same check for every harness file, and its scope already lists `opencode.json`. #1204's implementation follows #1205 (owner decision 6): #1205 brings the check and its message for the entry's current location, and #1204 extends it to the two locations of this ADR and adds the move.

### 8. What is removed

The implementation removes, completely:

- The `enabled: true` field and the `mcp.calavera` location from what `--init` writes and from the setup notes it writes.
- `createOpenCodeMcpJsonConfig`'s current shape, which becomes the `mcp.servers` shape.
- The README and `docs/agent-first-calavera-workflow.md` text that says "OpenCode stores local MCP servers under `mcp`".

No flag, environment variable, recipe setting, or `--mcp-harness` value brings the old layout back, and the version check of Decision 6 only warns. There is no `opencode-v1` harness.

What stays is recognition, not support. The old shape survives in one function, `createEarlierOpenCodeMcpEntry`, which only `openCodeMcpLocations` calls, for matching; a test asserts that no writer writes its output. `--init` and `eject` recognize the entry that releases 2.2.0 through 6.2.1 wrote, so that `--init` can move it and `eject` can remove it. Calavera never writes that shape again. This follows how Calavera already treats text that earlier releases wrote: `findEarlierGuidance` recognizes every earlier setup notes template so that a rerun can replace it, without writing any of them. Without this recognition, a rerun of `--init` would report every existing OpenCode setup as edited, and `eject` would leave every entry an earlier release wrote, which ADR-0017 promises to remove.

### 9. How C8 holds

The project brief's safety invariants (C8, `docs/evolution-brief.md`) hold. Only the CLI writes into projects: `--init` and `eject` remain the only writers of `opencode.json`, and the version check of Decision 6 writes nothing. Local edits are preserved: an edited entry is never rewritten, by `--init` (Decision 2) or by `eject` (Decision 4), and the implementation proves both with tests that fail when the check is removed. `dry_run_apply` stays the approval boundary, and `eject`'s dry run and approval are unchanged. Nothing is written to `package.json`. A conflict surfaces as a migration decision left to the person: the `manual` result of `--init` names the entry and the choices, which are to move it, translate it, or remove it, and `eject` keeps and reports the entry, as ADR-0017, Decision 6, specifies. The C8 safety-property tests need no change; the implementation must not modify them.

## Litmus test

The litmus test asks whether Calavera fights with or reimplements something that Vite or Vite+ does well. It is not what triggers this removal: the trigger is OpenCode 2, whose schema marks the layout Calavera writes today as deprecated (Context). The removal does not conflict with the litmus test, because Vite+ does not configure OpenCode or any other MCP host.

## Consequences

A person on OpenCode 1.x can no longer use Calavera's `--init` to configure OpenCode, and a rerun of `--init` on an existing project moves the entry to a layout that OpenCode's migration guide says not to point OpenCode 1.x at (Decision 5). When their 1.x `opencode` is on the `PATH`, the warning of Decision 6 tells them before the write. OpenCode 2 reads both layouts, so a person who upgrades OpenCode first loses nothing.

OpenCode still publishes 1.x releases alongside 2.x: `v1.19.6` was published on 2026-11-17, after `v2.3.0`. The implementation therefore reads the latest 1.x tag at the time it runs, not `v1.19.6` by default, when it confirms Decision 5 (owner decision 5), and checks that the `--version` source of Decision 6 is unchanged at that tag and at the latest 2.x tag.

`--init` with OpenCode chosen now starts one child process, for at most 5 seconds, when `opencode` is installed. This is the first time `--init` runs a tool that the person installed for another purpose; Decision 6 limits it to one fixed argument, no shell, and a neutral working folder.

`opencode.json` changes shape for every project that reruns `--init` with OpenCode chosen. The move is one write, shown in the summary and in `--json`, and its result is what OpenCode documents.

The implementation starts from the saved patch, `1089-opencode-v2-and-cursor.patch` in the shared Git folder (`git rev-parse --git-common-dir`), and drops its Cursor half, which PR #1200 shipped. Three bugs in the patch are fixed first, each with a test: the duplicated block in the `eject` plan that #1204 names; the misreading of a server named `servers` (Decision 3); and the overwrite of `mcp.servers.calavera`, which the patch replaces even when that entry is edited, including during a move, contrary to Decision 2. The patch's changeset is a `patch` bump that also describes the Cursor change, so the implementation rewrites it as a major bump that states that OpenCode 2 is required (owner decision 1).

The setup notes template for the next release is `6.3.0`, which PR #1200 registered and no release has written yet. The implementation edits that template's OpenCode block rather than adding another template, because only published releases need a template of their own. #1185 merged a major changeset for `create-project-calavera` (PR #1203), so the next release is 7.0.0, and the release lists of the `6.3.0` template and of its epoch name 7.0.0 instead of 6.3.0 (owner decision 1); `earlier-guidance-table.test.mjs` already fails when a published version is in no template.

The docs change with the implementation: the README's MCP section and `docs/agent-first-calavera-workflow.md` show the new shape, state the OpenCode 2 requirement, and describe the version warning, and the changeset says what an OpenCode 1.x user sees.

## Owner decisions

The owner answered the six open questions of the first draft on 2026-11-23 in https://github.com/schalkneethling/create-project-calavera/issues/1204#issuecomment-7097357478. The owner accepted every recommendation except question 2. The reasons below come from the first draft's recommendations, except for decision 2, whose reason is the owner's choice and the design that Decision 6 gives it.

1. **Version bump: major.** The changeset states that OpenCode 2 is required, and the unreleased `6.3.0` setup notes template lists 7.0.0, because #1185 already shipped a major changeset. Reason: a person on OpenCode 1.x who reruns `--init` gets an `opencode.json` in a layout their OpenCode is not meant to read, so a working setup stops working. ADR-0021 chose a major bump for a removal with that effect. The Consequences apply this.
2. **Detecting OpenCode 1.x: warn.** When `opencode` is on the `PATH`, `--init` runs `opencode --version` and warns about a 1.x version before it writes the OpenCode 2 layout. A missing or failing `opencode` changes nothing and is not an error. The first draft recommended no detection, because Calavera does not probe a person's installed tools for any other host, and the `opencode` on the `PATH` may not be the one a person runs. The owner chose the warning, so that a person on 1.x learns of the requirement before the write rather than when OpenCode fails. Decision 6 keeps the check to one fixed argument, no shell, a timeout, and a neutral working folder, and it never blocks the write, which answers the first draft's concerns about cost and safety. A stale `opencode` on the `PATH` can still give a wrong warning or none, which the warning's wording allows for by naming the version it found.
3. **The `mcp.servers` rule: accepted.** `mcp.servers` counts as OpenCode 2's server container only when every member is an object; otherwise `--init` leaves the file unchanged with a remedy. Reason: `servers` is the only reserved key that Calavera writes into, and refusing is the only outcome that cannot corrupt a person's OpenCode 1.x server of that name. Decision 3 applies this.
4. **Mixed entries: the whole file stays unchanged.** When one entry is edited, `--init` leaves the whole file unchanged and reports both locations with the remedy. Reason: removing only the unedited entry changes the file while the person still has a conflict to resolve, and C8 forbids rewriting the edited one. Decision 2 applies this.
5. **Confirming the 1.x behavior.** The implementation reads OpenCode's configuration source at its last 1.x tag, and runs the 1.x binary once if it still installs. Reason: the source is cheaper and repeatable, and a quoted message lets a 1.x user recognize the cause. Decision 5 and the Consequences apply this.
6. **Order: #1204 follows #1205.** #1205 adds the edited-entry check for every harness file, and #1204's implementation extends it for `opencode.json`. Reason: #1205 is already in progress, and the other order would make #1204 write a check and message that #1205 then rewrites. Decision 7 applies this.

## Alternatives considered

- **Keep writing the OpenCode 1.x layout.** Rejected by the owner's decision of 2026-11-23. OpenCode 2 reads it today, but its schema marks it as deprecated, and Calavera would keep writing a shape its host is retiring.
- **Write both layouts.** Rejected: OpenCode 2 reads both, so the file would hold two servers named `calavera`, and OpenCode 1.x would still reject the `mcp.servers` member.
- **A flag or a harness value for OpenCode 1.x, such as `--mcp-harness opencode-v1`.** Rejected: the repository rules call for complete removals with no legacy modes, and OpenCode's migration guide already covers 1.x users.
- **Detect the OpenCode version and choose the layout.** Rejected: it would keep the 1.x writer as a hidden legacy path. Decision 6 detects the version only to warn.
- **Stop `--init` when OpenCode 1.x is found.** Rejected by owner decision 2: the check never blocks the write, because the `opencode` on the `PATH` may not be the one that opens the project, and a person may be about to upgrade.
- **Run `opencode --version` through a shell, or in the project folder.** Rejected: a shell would parse a command line for no benefit, and in the project folder OpenCode could read the project's configuration while it starts, which a version question does not need.
- **Migrate an edited entry by translating `enabled` to `disabled`.** Rejected: an edited entry is the person's, and the safety invariants (C8) forbid rewriting it without their approval. The remedy points them to OpenCode's own migration guide instead.
- **Stop all of `--init` when the entry is edited.** Rejected: the other steps of `--init` do not depend on `opencode.json`, and today's `manual` result already reports a failed MCP write with a remedy while the rest continues.
