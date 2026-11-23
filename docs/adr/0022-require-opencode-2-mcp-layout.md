# ADR-0022: Require OpenCode 2 and Write Its MCP Layout

- **Status:** Proposed
- **Date:** 2026-11-23
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/1204
- **Decides:** Calavera requires OpenCode 2 and drops OpenCode 1.x support. `--init` writes the `calavera` entry in `opencode.json` under `mcp.servers`, the layout OpenCode 2 documents, with no `enabled` or `disabled` field. An unedited entry that an earlier release wrote directly under `mcp` moves to `mcp.servers`. An edited entry is never rewritten: `--init` leaves `opencode.json` unchanged and reports the entry with a remedy, and the rest of `--init` continues. `eject` recognizes the new entry and the entry that every earlier release wrote as unedited, and keeps and reports an edited one. No flag, setting, version check, or deprecated path writes the OpenCode 1.x layout. The owner decided the direction on 2026-11-23 (https://github.com/schalkneethling/create-project-calavera/issues/1089, owner comment of that date). This document changes no code. The issue's scope puts the ADR and the removal in one pull request; this ADR is proposed on its own first so that the owner can answer its open questions before the code changes, and the implementation pull request closes #1204.

## Context

#1089 asked whether the bootstrap writes MCP entries in the shapes that OpenCode and Cursor document today. PR #1200 shipped the Cursor half: `.cursor/mcp.json` now carries `"type": "stdio"`. The OpenCode half differs in kind, because OpenCode 2 moved MCP servers to a new place in `opencode.json`, and OpenCode's migration guide warns against pointing OpenCode 1.x at files in the new layout. Writing the new layout therefore means dropping OpenCode 1.x, which makes it a removal. The repository rules call for one pull request and one ADR per removal, with no deprecated paths, flags, or legacy modes left behind.

#1205 is in progress and changes the same entries. It makes a rerun of `--init` leave an edited `calavera` MCP entry alone, in every harness file, instead of overwriting it as today. This ADR applies the same rule to the OpenCode migration and names the one function both changes share (Decision 6).

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

The first element of `command` and the arguments before `--package` depend on the package manager: `npx`, `pnpm dlx`, `yarn dlx`, or `bunx` (`createPackageRunnerCommand`, `packages/cli/src/index.js`, lines 2116 to 2127). The setup notes in `.agents/calavera/mcp.md` show the same entry, built by the same function (`index.js`, line 2194).

Every release that offers OpenCode wrote this one shape. The writer itself shows it: `mcp-config.js` at the tags `v2.2.0` (under `src/utils/`), and `v3.0.0`, `v5.0.0`, and `v6.0.0` (under `packages/cli/src/utils/`), writes the same `type`, `command`, and `enabled: true`, and the writer did not exist at `v2.1.2`. The setup notes templates in `packages/cli/fixtures/agent-guidance/mcp/` record what each release wrote: the OpenCode block first appears in the `2.2.0` template, and its JSON is identical, apart from the pinned version, in every template from `2.2.0` through the unreleased `6.3.0`, for all four package managers. The `2.1.2` and earlier templates have no OpenCode block. The released version is 6.2.1.

### What `eject` matches

`planJsonMcpEntry` (`packages/cli/src/eject.js`) looks for `calavera` directly under `mcp` in `opencode.json`. The entry is unedited when it equals the entry Calavera writes for some package manager, with the pinned version normalized (owner decision of 2026-11-17 on #678). An edited entry is kept and reported (ADR-0017, Decisions 2 and 6). `eject` does not look under `mcp.servers` today.

### What happens when a write fails

`writeAgentBootstrapMcpConfig` (`index.js`, lines 4385 to 4437) turns an error from any harness writer into a `manual` result: it discards the pending changes for that file, and the summary prints "Could not write project MCP config at <path>: <reason>" followed by the manual setup instructions. The rest of `--init` continues.

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

"Unedited" means equal, with the pinned version normalized, to the entry some release wrote at that location for some package manager; Decision 6 names the function that decides it. "Edited" means any other value. Every case that leaves the file unchanged reports the result as `manual`, which is today's outcome for a failed MCP write (Context), and the rest of `--init` continues.

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

For an edited entry directly under `mcp`, the remedy reads: "opencode.json holds a calavera entry directly under mcp that differs from the entry Calavera wrote, so Calavera leaves the file unchanged. OpenCode 2 reads servers from mcp.servers: move the entry there and replace enabled with disabled, as OpenCode's migration guide describes, or remove it, then run --init again." When that entry holds only `enabled`, the 1.x way to switch off a server configured elsewhere, the remedy instead says to remove it, or to set `"disabled": true` on the full entry under `mcp.servers`, because an entry under `mcp.servers` needs `type` and `command`. For an edited entry under `mcp.servers`, the message is the one #1205 writes for every harness (Decision 6). Each message names the file and the location, never the entry's value, which can hold an `environment` with secrets.

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

Calavera does not detect which OpenCode version a person runs (open question 2). A person on OpenCode 1.x meets the change in one of three ways:

- **A new setup.** `--init` writes `mcp.servers.calavera`. OpenCode 1.x reads every member of `mcp` as a server, so it reads a server named `servers` whose value is `{ "calavera": { … } }`. That value has no `type` and holds a key other than `enabled`, so it matches none of the shapes that OpenCode 2's schema allows for the deprecated layout. The expected result is that OpenCode 1.x rejects `opencode.json` as invalid, or at least does not start Calavera's server. This is derived from OpenCode 2's description of the old layout, not from OpenCode 1.x itself; open question 5 asks the implementation to confirm it.
- **A rerun of `--init` on a project that an earlier release set up.** The unedited entry moves to `mcp.servers`, and the person sees the same result as a new setup. The summary names the move under `opencode.json`: "Moved the calavera entry from mcp to mcp.servers, the layout OpenCode 2 reads. OpenCode's migration guide says not to point OpenCode 1.x at files in this layout: install OpenCode 2, or restore opencode.json from version control." The `--json` result carries the same text in the `reason` field of the `update` result, which today appears only on a `manual` result (`index.js`, lines 4385 to 4437), so an agent reading `--json` learns of the move too.
- **No rerun.** Nothing changes. The entry an earlier release wrote keeps working in OpenCode 1.x, and in OpenCode 2 as a deprecated member.

The README and the setup notes state the requirement next to the OpenCode example: "Calavera requires OpenCode 2. OpenCode's migration guide says not to point OpenCode 1.x at files in the `mcp.servers` layout." The changeset says the same.

### 6. One matching function and one list of locations

`--init` (Decision 2) and `eject` (Decision 4) decide "unedited" with one function, `matchesMcpEntry` in `packages/cli/src/utils/mcp-config.js`, which the saved patch introduces. It compares an entry with the list of entries Calavera writes at that location, with the pinned version normalized, and an entry that holds the version placeholder matches none. The saved patch still builds the pairing of each location with its expected entries twice, once in `writeOpenCodeMcpConfig` and once in `eject`'s `planMcpEntries`, and takes the launch commands from two call sites. The implementation adds one exported list in `mcp-config.js`, `openCodeMcpLocations(launchCommands)`, that returns each location with its expected entries, and both commands read it, so a future change to an entry updates `--init` and `eject` together.

#1205 adds the edited check for `mcp.servers.calavera`, as part of the same check for every harness file, and its scope already lists `opencode.json`. To keep one issue to one pull request, #1204 follows #1205: #1205 brings the check and its message for the entry's current location, and #1204 extends it to the two locations of this ADR and adds the move. Open question 6 asks the owner to confirm this order and to place both issues in the sequencing map.

### 7. What is removed

The implementation removes, completely:

- The `enabled: true` field and the `mcp.calavera` location from what `--init` writes and from the setup notes it writes.
- `createOpenCodeMcpJsonConfig`'s current shape, which becomes the `mcp.servers` shape.
- The README and `docs/agent-first-calavera-workflow.md` text that says "OpenCode stores local MCP servers under `mcp`".

No flag, environment variable, recipe setting, `--mcp-harness` value, or OpenCode version check brings the old layout back. There is no `opencode-v1` harness.

What stays is recognition, not support. The old shape survives in one function, `createEarlierOpenCodeMcpEntry`, which only `openCodeMcpLocations` calls, for matching; a test asserts that no writer writes its output. `--init` and `eject` recognize the entry that releases 2.2.0 through 6.2.1 wrote, so that `--init` can move it and `eject` can remove it. Calavera never writes that shape again. This follows how Calavera already treats text that earlier releases wrote: `findEarlierGuidance` recognizes every earlier setup notes template so that a rerun can replace it, without writing any of them. Without this recognition, a rerun of `--init` would report every existing OpenCode setup as edited, and `eject` would leave every entry an earlier release wrote, which ADR-0017 promises to remove.

### 8. How C8 holds

The project brief's safety invariants (C8, `docs/evolution-brief.md`) hold. Only the CLI writes into projects: `--init` and `eject` remain the only writers of `opencode.json`. Local edits are preserved: an edited entry is never rewritten, by `--init` (Decision 2) or by `eject` (Decision 4), and the implementation proves both with tests that fail when the check is removed. `dry_run_apply` stays the approval boundary, and `eject`'s dry run and approval are unchanged. Nothing is written to `package.json`. A conflict surfaces as a migration decision left to the person: the `manual` result of `--init` names the entry and the choices, which are to move it, translate it, or remove it, and `eject` keeps and reports the entry, as ADR-0017, Decision 6, specifies. The C8 safety-property tests need no change; the implementation must not modify them.

## Litmus test

The litmus test asks whether Calavera fights with or reimplements something that Vite or Vite+ does well. It is not what triggers this removal: the trigger is OpenCode 2, whose schema marks the layout Calavera writes today as deprecated (Context). The removal does not conflict with the litmus test, because Vite+ does not configure OpenCode or any other MCP host.

## Consequences

A person on OpenCode 1.x can no longer use Calavera's `--init` to configure OpenCode, and a rerun of `--init` on an existing project moves the entry to a layout that OpenCode's migration guide says not to point OpenCode 1.x at (Decision 5). OpenCode 2 reads both layouts, so a person who upgrades OpenCode first loses nothing.

`opencode.json` changes shape for every project that reruns `--init` with OpenCode chosen. The move is one write, shown in the summary and in `--json`, and its result is what OpenCode documents.

The implementation starts from the saved patch, `1089-opencode-v2-and-cursor.patch` in the shared Git folder (`git rev-parse --git-common-dir`), and drops its Cursor half, which PR #1200 shipped. Three bugs in the patch are fixed first, each with a test: the duplicated block in the `eject` plan that #1204 names; the misreading of a server named `servers` (Decision 3); and the overwrite of `mcp.servers.calavera`, which the patch replaces even when that entry is edited, including during a move, contrary to Decision 2. The patch's changeset is a `patch` bump that also describes the Cursor change, so the implementation rewrites it.

The setup notes template for the next release is `6.3.0`, which PR #1200 registered and no release has written yet. The implementation edits that template's OpenCode block rather than adding another template, because only published releases need a template of their own. Open PR #1203 (#1185) adds a major changeset for `create-project-calavera`, so if it merges first, the next release is 7.0.0 whatever this ADR decides, and the release list of the `6.3.0` template and of its epoch must name 7.0.0; `earlier-guidance-table.test.mjs` already fails when a published version is in no template.

The docs change with the implementation: the README's MCP section and `docs/agent-first-calavera-workflow.md` show the new shape and state the OpenCode 2 requirement, and the changeset says what an OpenCode 1.x user sees.

## Open questions for the owner

1. **Version bump.** Should the changeset be a major or a minor bump for `create-project-calavera`? Recommendation: major. A person on OpenCode 1.x who reruns `--init` gets an `opencode.json` in a layout their OpenCode is not meant to read, so a working setup stops working. ADR-0021 chose a major bump for a removal with that effect. If #1203 merges first, the next release is already major, and this changeset's bump changes nothing in the version.
2. **Detecting OpenCode 1.x.** Should `--init` run `opencode --version` and warn when it finds 1.x? Recommendation: no. Calavera writes project files and does not probe the person's installed tools for any other host. OpenCode may not be on the `PATH` of the shell that runs `--init`, and a project is often shared by people on different versions. The README, the setup notes, and the move message of Decision 5 state the requirement where the change happens.
3. **What `mcp.servers` must hold.** Should `--init` and `eject` accept `mcp.servers` as the OpenCode 2 container only when every member is an object, and refuse otherwise with the messages of Decision 3? Recommendation: yes. `servers` is the only reserved key Calavera writes into, and refusing is the only outcome that cannot corrupt a person's OpenCode 1.x server of that name. The alternative, treating every `mcp.servers` object as the container, writes `calavera` into that server.
4. **One file, all or nothing.** When one entry is edited and the other is not, should `--init` leave the whole file unchanged (Decision 2), or remove the unedited one? Recommendation: leave the whole file unchanged. Removing only the unedited entry changes the file while the person still has a conflict to resolve, and the person resolves both at once from one message.
5. **Confirming what OpenCode 1.x shows.** How should the implementation confirm Decision 5? Recommendation: read the MCP schema in the configuration module of OpenCode's source at its last 1.x tag, which is cheaper and repeatable, and run the last 1.x release once against a new `opencode.json` in a scratch folder if it still installs. The pull request quotes what each shows, and the README quotes OpenCode 1.x's message if the probe ran. If neither can run, the README keeps the wording of Decision 5, and the pull request says so.
6. **Order of #1204 and #1205.** Should #1204 follow #1205, so that #1205 brings the edited check for every harness file and #1204 extends it for `opencode.json` (Decision 6)? Recommendation: yes, with both added to the sequencing map in the same column, #1205 first. #1205 is already in progress, and the other order would make #1204 write a check and message that #1205 then rewrites.

## Alternatives considered

- **Keep writing the OpenCode 1.x layout.** Rejected by the owner's decision of 2026-11-23. OpenCode 2 reads it today, but its schema marks it as deprecated, and Calavera would keep writing a shape its host is retiring.
- **Write both layouts.** Rejected: OpenCode 2 reads both, so the file would hold two servers named `calavera`, and OpenCode 1.x would still reject the `mcp.servers` member.
- **A flag or a harness value for OpenCode 1.x, such as `--mcp-harness opencode-v1`.** Rejected: the repository rules call for complete removals with no legacy modes, and OpenCode's migration guide already covers 1.x users.
- **Detect the OpenCode version and choose the layout.** Rejected for the reasons in open question 2, and because it would keep the 1.x writer as a hidden legacy path.
- **Migrate an edited entry by translating `enabled` to `disabled`.** Rejected: an edited entry is the person's, and the safety invariants (C8) forbid rewriting it without their approval. The remedy points them to OpenCode's own migration guide instead.
- **Stop all of `--init` when the entry is edited.** Rejected: the other steps of `--init` do not depend on `opencode.json`, and today's `manual` result already reports a failed MCP write with a remedy while the rest continues.
