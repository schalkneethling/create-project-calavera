# AI Adapter Guidance

Calavera installs AI artifacts into a canonical project layout under
`.agents/`. Vendor tools may need extra configuration before they consume those
files. Keep that adapter step separate from Calavera's managed output so
`apply`, `doctor`, `update`, and `clean` can keep tracking the files they own.

## Canonical Layout

```text
.agents/
  skills/
    <skill-name>/
  hooks/
    <target>/
      <hook-name>.mjs
  agents/
    <target>/
      <agent-name>.md
```

Skills are written directly under `.agents/skills/` because they are intended to
be portable source artifacts. Hooks and agents include a `target` directory
because their runtime shape is usually vendor-specific. Preserved Toolkit hooks
and agents default to `claude-code`.

Calavera does not currently write `.claude/`, `.codex/`, editor settings, global
agent directories, symlinks, or machine-local configuration. If a tool needs one
of those locations, wire it up explicitly after reviewing the generated files.

## Claude Code

The bundled hook scripts are Claude Code hooks. They install to
`.agents/hooks/claude-code/` by default and are paired with source
`settings-fragment.json` files in the Calavera package.

After `apply`, review each fragment before merging it into
`.claude/settings.json`. The checked-in fragments currently point at the default
target paths:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node .agents/hooks/claude-code/block-dangerous-commands.mjs"
          }
        ]
      }
    ]
  }
}
```

If a recipe sets a different hook `target`, update the command path in the
Claude settings you merge. The hook payload and event names are still Claude
Code-specific; changing `target` only changes where Calavera writes the script.

Preserved Toolkit agents install under `.agents/agents/claude-code/` by default
in their original Markdown/frontmatter format. Treat those files as source
material for Claude-style agent workflows rather than as a generic agent schema.

## Codex

Codex supports repository skills under `.agents/skills/`, so Calavera-installed
skills are already in the project-scoped location Codex scans when launched from
the repository. Keep those files checked in when the workflow should travel with
the project. Use a personal skill location only when a skill should apply across
repositories instead of living with this project.

For bundled agent artifacts, set `target` to `codex` when you want Calavera to
write a Codex custom-agent TOML file:

```json
{
  "type": "agent",
  "src": "agents/technical-devils-advocate.md",
  "target": "codex"
}
```

That installs `.codex/agents/technical-devils-advocate.toml`. The adapter carries
over the source name, description, and body instructions as Codex `name`,
`description`, and `developer_instructions`. It omits the Claude-specific source
`model` field because Codex custom agents use Codex model IDs and can inherit the
active model configuration when no model is set.

Hook scripts are also not Codex hooks. The current bundled hooks read Claude
Code hook payloads from stdin and expect Claude Code event names.

## Other Agent Tools

For other tools, treat `.agents/` as the stable handoff boundary:

- Use `.agents/skills/` when the tool can consume skill-style directories or
  when you want project-local source that can be copied into the tool's own
  skill location.
- Use `.agents/hooks/<target>/` only after confirming the hook runtime payload,
  event names, command format, and timeout behavior match the target tool.
- Use `.agents/agents/<target>/` as source material unless the target tool
  explicitly supports the preserved Markdown/frontmatter schema.

Prefer a new `target` value when experimenting with a different tool, for
example `target: "codex"` or `target: "custom-agent-runner"`. That keeps vendor
experiments reviewable without implying Calavera has a working adapter for that
runtime.

## Ownership Rules

Calavera-managed files remain under `.agents/`, except for Codex-adapted agent
TOML files under `.codex/agents/`. Managed paths are tracked in
`.calavera/state.json`. Manual copies, symlinks, merged settings files, and
other vendor runtime directories are user-owned unless a future adapter
explicitly adds managed support for them.

When in doubt, re-run `create-project-calavera apply --dry-run` or
`create-project-calavera doctor` to inspect Calavera-owned state before changing
the vendor-specific wiring.
