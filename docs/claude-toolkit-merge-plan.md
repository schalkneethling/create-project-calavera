# Claude Toolkit Merge Plan

## Summary

Merge `schalkneethling/claude-toolkit` into `create-project-calavera` as
Calavera's AI artifact module. After the phase-one merge, Calavera owns the
bundled AI assets and can apply user-composed AI artifacts from
`calavera.config.json`.
The standalone Toolkit package remains available only long enough to point users
at Calavera, then it is deprecated and the repository is archived.

## Repositories

- Calavera local checkout:
  `/Users/schalkneethling/dev/opensource/create-project-calavera`
- Toolkit local checkout:
  `/Users/schalkneethling/dev/opensource/claude-toolkit`
- Calavera GitHub:
  <https://github.com/schalkneethling/create-project-calavera>
- Toolkit GitHub:
  <https://github.com/schalkneethling/claude-toolkit>

## Tracking Issues

Calavera implementation:

- [#143 Audit claude-toolkit behavior and define the Calavera AI module contract](https://github.com/schalkneethling/create-project-calavera/issues/143)
- [#142 Add AI recipe schema support and bundle the Toolkit catalog](https://github.com/schalkneethling/create-project-calavera/issues/142)
- [#144 Implement AI artifact apply into the canonical .agents layout](https://github.com/schalkneethling/create-project-calavera/issues/144)
- [#146 Track AI artifacts in state and extend doctor update clean](https://github.com/schalkneethling/create-project-calavera/issues/146)
- [#133 Surface post-install pointers after applying a recipe](https://github.com/schalkneethling/create-project-calavera/issues/133)
- [#145 Document the AI config, .agents layout, and Toolkit migration path](https://github.com/schalkneethling/create-project-calavera/issues/145)

Transferred Toolkit follow-up work:

- [#147 Improve frontend-security audit workflow, severity model, and scope routing](https://github.com/schalkneethling/create-project-calavera/issues/147)
- [#148 Tighten XSS, DOM, URL, and CSP guidance in frontend-security skill](https://github.com/schalkneethling/create-project-calavera/issues/148)
- [#149 Align CSRF, JWT, and browser token storage guidance](https://github.com/schalkneethling/create-project-calavera/issues/149)
- [#150 Correct input validation, parsing, and output encoding examples](https://github.com/schalkneethling/create-project-calavera/issues/150)
- [#151 Harden file upload and archive handling guidance](https://github.com/schalkneethling/create-project-calavera/issues/151)
- [#152 Revise Node/npm supply-chain and command execution guidance](https://github.com/schalkneethling/create-project-calavera/issues/152)

Toolkit deprecation:

- [claude-toolkit #51 Deprecate claude-toolkit after the Calavera AI merge ships](https://github.com/schalkneethling/claude-toolkit/issues/51)

## Decisions

- Use `ai` as the new top-level `calavera.config.json` key.
- Use `.agents/` as the canonical project output root.
- Treat `ai` as the complete user-composed AI artifact list. Toolkit's static
  named collections do not become default Calavera presets.
- Let hook and agent items choose their `.agents/` target directory with
  `target`, defaulting to `claude-code` for preserved Toolkit artifacts.
- Fold AI operations into the existing lifecycle commands instead of creating a
  separate `calavera ai` command family.
- Keep Toolkit content unchanged during the move. Content improvements are
  follow-up work after the merge plumbing is stable.
- Keep Calavera as the single source of managed state through
  `.calavera/state.json`.
- Transfer still-relevant Toolkit issues, such as AI security guidance skill
  updates, into the Calavera repository before archiving Toolkit.

## Current-State Notes

Calavera already has the right lifecycle shape: `init`, `apply`, `doctor`,
`update`, `clean`, `--dry-run`, `--json`, and `.calavera/state.json`.
Its current state file tracks managed paths, but does not yet track source
hashes or rich artifact ownership metadata.

Toolkit currently ships:

- 13 skill directories under `skills/`
- 2 hook directories under `hooks/`
- 1 agent under `agents/`
- a root `config.json` containing the `web` and `code-review` collections

Toolkit writes hooks into `.claude/`, skills and agents into
`.claude-toolkit/`, and links them into Claude-specific locations. The Calavera
merge replaces that with canonical `.agents/` writes.

## Phase-One Scope

Phase one is complete when a user can place an `ai` section in
`calavera.config.json`, run `create-project-calavera apply`, and get the
expected `.agents/` tree from Calavera's bundled catalog.

The phase includes:

- Toolkit behavior audit and merge contract
- AI catalog and recipe support
- bundled Toolkit asset migration
- AI artifact apply
- post-install pointers for AI artifact follow-up guidance
- state tracking for managed AI artifacts
- `doctor`, `update`, and `clean` support
- README and migration documentation
- Calavera replacement release
- Toolkit deprecation after the replacement release exists

## Non-Goals

Defer these until after the merge:

- Vite+ awareness or lint/format delta mode
- the `@schalkneethling/create` template
- composer UI controls for the `ai` section
- WebMCP tool registration for AI operations
- adapters that transform Toolkit agent Markdown into Codex custom-agent TOML
- vendor-specific adapter prompts beyond migration guidance
- editing or renaming Toolkit's existing skill, hook, or agent content

## Target Config Shape

```json
{
  "$schema": "https://calavera.dev/schema/calavera.config.schema.json",
  "version": 1,
  "profile": "modern",
  "packageManager": "pnpm",
  "integrations": [],
  "ai": [
    { "type": "skill", "src": "skills/semantic-html" },
    { "type": "skill", "src": "skills/css-coder" },
    {
      "type": "hook",
      "src": "hooks/block-dangerous-commands",
      "target": "claude-code"
    }
  ]
}
```

The `ai` value is a direct list of artifact items chosen by the user or by a
configuration surface such as the CLI, Web UI, or future WebMCP tools. Item
`type` supports `skill`, `hook`, and `agent`. Hook and agent items may set
`target` to choose the `.agents/hooks/<target>/` or `.agents/agents/<target>/`
directory; if omitted, Calavera uses `claude-code` for the preserved Toolkit
format.

## Target Output Layout

```text
.agents/
  skills/
    semantic-html/
  hooks/
    <target>/
      block-dangerous-commands.mjs
  agents/
    <target>/
      technical-devils-advocate.md
```

The target directory is part of the user-composed AI item rather than a static
global surface.

## Implementation Sequence

1. Resolve the merge contract in issue #143.
   Confirm behavior that must survive the move, especially source hashing,
   local modification checks, settings fragments, executable bits, and managed
   ownership.

2. Land asset and schema support in issue #142.
   Copy Toolkit assets into the Calavera package, make `ai` accept a direct
   artifact-item list, and ensure package publishing includes those files.

3. Land `apply` support in issue #144.
   Resolve configured AI items, copy artifacts into `.agents/`, make repeated
   applies idempotent, and support `--dry-run` plus `--json`.

4. Land post-install pointers in issue #133.
   Use the pointer mechanism for concise AI artifact follow-up guidance, such
   as installed artifact locations or a reminder that Claude-specific hook
   settings may need manual review.

5. Land lifecycle support in issue #146.
   Extend `.calavera/state.json` with reusable managed-file hashes and AI
   artifact hashes, teach `doctor` to inspect AI artifacts, teach `update` to
   refresh changed bundled sources without clobbering user edits, and teach
   `clean` to remove only stale Calavera-owned items.

6. Land docs in issue #145.
   Update the README, add `MIGRATION.md`, document `.agents/`, and call out
   Claude-specific hook placement and the preserved Toolkit agent format.

7. Release Calavera with AI support.
   The replacement release should exist before any Toolkit npm deprecation or
   repository archival.

8. Complete Toolkit issue #51.
   Transfer open Toolkit issues that remain relevant to Calavera, update
   Toolkit's README, publish any final metadata-only release if needed, run
   `npm deprecate`, then archive the repository.

## Release Gate

Do not deprecate Toolkit until all of these are true:

- a Calavera release includes the bundled AI assets
- `create-project-calavera apply` can install a user-composed AI list
  equivalent to Toolkit's old `web` collection into `.agents/`
- README and migration docs are published
- `apply` can surface relevant post-install pointers for AI artifacts in both
  human-readable and JSON output
- npm package contents include the AI assets needed at runtime
- a second `apply` run is idempotent on an unchanged project
- still-relevant Toolkit issues have been transferred or intentionally closed
  with migration context

## Open Decisions

- Whether Claude-specific settings fragments are copied, transformed, or
  documented only.
- Whether and how to add a Codex custom-agent adapter for Toolkit agent
  Markdown.
- How strongly Calavera should detect local edits for directory-based skills,
  where Toolkit currently tracks source hashes but does not check installed
  directory modifications.
