# AI Module Contract

This document records the phase-one contract for merging
`schalkneethling/claude-toolkit` into Calavera.

## Ownership

Calavera owns the bundled AI artifact catalog after the merge. The standalone
`claude-toolkit` package remains only as a historical/deprecation path once a
Calavera release can replace its core behavior.

## Recipe Key

The recipe key is `ai`.

Calavera's primary recipe shape is a direct list of AI artifact items:

```json
{
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

This matters because Calavera composes AI configuration dynamically through the
CLI, Web UI, and future WebMCP surfaces. Unlike Toolkit, users are not choosing
from a static root `config.json` collection. The recipe's `ai` key is the
complete AI artifact selection. Hook and agent items may set `target` to choose
their `.agents/` target directory. When omitted, Calavera defaults preserved
Toolkit hook and agent items to `claude-code`.

## Bundled Catalog

The Toolkit assets are now bundled under `src/ai/`:

- `src/ai/skills/`
- `src/ai/hooks/`
- `src/ai/agents/`

Toolkit's static root `config.json` collections are not carried forward as
default Calavera presets. Users and configuration surfaces choose the exact
skills, hooks, and agents to include.

Phase one preserves Toolkit artifact contents. Renames, content edits, and
vendor-neutral rewrites are follow-up work.

## Output Layout

Calavera writes canonical AI artifacts to `.agents/`:

```text
.agents/
  skills/
  hooks/
    <target>/
  agents/
    <target>/
```

Skills are vendor-neutral and install directly under `.agents/skills/`.
Toolkit's current hooks are Claude Code-specific, so they default to the
`claude-code` target directory. Toolkit's current agent files are preserved in
their original Markdown/frontmatter format by default. When an agent item sets
`target` to `codex`, Calavera adapts the source Markdown into a Codex
custom-agent TOML file under `.codex/agents/`.

Vendor-specific consumption guidance lives in
[`docs/ai-adapter-guidance.md`](ai-adapter-guidance.md). That guidance is about
using the canonical `.agents/` output with specific tools; it does not expand
Calavera ownership to vendor runtime directories or settings files.

## Source Resolution

AI item `src` values resolve against the bundled `src/ai/` root and must stay
inside the matching top-level artifact directory:

- `skill`: `skills/<name>`
- `hook`: `hooks/<name>`
- `agent`: `agents/<name>.md`

## Managed State And Write Safety

Calavera's managed state lives in `.calavera/state.json`. Generated files are
tracked under `managedFiles` with their destination path and content hash. AI
artifacts use the same safety model and are tracked under `aiArtifacts`, with
the artifact type, name, recipe source, target, destination path, and source
hash.

The source hashing follows Toolkit's current behavior:

- hooks hash `hook.mjs`
- skills hash every file in the skill directory
- agents hash the Markdown source file

For both generated files and AI artifacts, Calavera refuses to overwrite an
existing destination when that destination is not recorded as Calavera-managed,
or when the installed content no longer matches the recorded state hash. `clean`
uses the same hashes and skips stale managed items that have local edits.

## Post-Install Pointers

`apply` returns post-install pointers in both human-readable output and JSON
output. This is a general Calavera mechanism for concise follow-up guidance;
AI artifacts can contribute pointers such as:

- installed skills being available under `.agents/skills/`
- Claude Code hook settings fragments needing manual review

## Documentation Rule

Implementation and documentation move together. Each AI module behavior change
should update the relevant README, migration, contract, or schema documentation
in the same PR whenever practical. Issue #145 remains the final documentation
sweep, not the only documentation step.
