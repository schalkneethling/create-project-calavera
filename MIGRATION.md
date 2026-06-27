# Migrating from claude-toolkit to Calavera

`claude-toolkit` is being merged into Calavera as the AI artifact module.
This guide covers the phase-one migration path.

## What Changes

- Use `create-project-calavera apply` instead of `toolkit add ...`.
- Put AI artifact intent in `calavera.config.json` under the `ai` key.
- Treat `ai` as a user-composed artifact list. Calavera's CLI, Web UI, and
  agent surfaces can build this list dynamically.
- Calavera writes the canonical project layout under `.agents/`.
- Calavera tracks managed AI artifacts in `.calavera/state.json`.

## What Stays Familiar

- Collection items keep the Toolkit shape: `{ "type": "skill", "src": "..." }`.
- Bundled Toolkit assets are copied into Calavera without content changes.
- Skill directories, hook scripts, agents, and source hashes remain reviewable
  as ordinary project files.

## Collection Migration

Toolkit's root `config.json` collection:

```json
[
  {
    "name": "web",
    "items": [
      { "type": "skill", "src": "skills/semantic-html" },
      { "type": "skill", "src": "skills/css-coder" }
    ]
  }
]
```

can become this Calavera recipe section:

```json
{
  "ai": [
    { "type": "skill", "src": "skills/semantic-html" },
    { "type": "skill", "src": "skills/css-coder" }
  ]
}
```

Toolkit's old named collection wrappers do not move forward. Copy the specific
items you want into `ai` instead.

## Output Layout

Toolkit wrote to `.claude/` and `.claude-toolkit/`.

Calavera writes to:

```text
.agents/
  skills/
  hooks/
    <target>/
  agents/
    <target>/
```

Hooks need more care because Toolkit hooks shipped Claude Code
`settings-fragment.json` files. Calavera installs hook scripts under
`.agents/hooks/claude-code/` by default, but hook items can set `target` to
choose another directory. Review the matching bundled settings fragments before
wiring them into `.claude/settings.json`.

Toolkit agent files are preserved in their original Markdown/frontmatter
format under `.agents/agents/claude-code/` by default. Agent items can set
`target` to choose another directory, but Codex custom subagents use a TOML
agent file schema, so installing these as Codex subagents should be handled by an
explicit adapter rather than by assuming the original Toolkit file works
unchanged.

## Deprecation Timing

Do not deprecate `claude-toolkit` until a Calavera release exists that can
install the bundled AI artifacts. After that release:

1. Update the Toolkit README to point here.
2. Publish any final Toolkit metadata-only release if needed.
3. Run `npm deprecate @schalkneethling/toolkit@*` with a Calavera migration
   message.
4. Archive the Toolkit repository.
