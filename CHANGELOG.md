# Changelog

## 2.0.5

### Fixed

- Use the target project's package manager in generated MCP setup guidance,
  including version-pinned Bun MCP commands.
- Keep JSON/MCP apply output from writing dependency-install spinner UI to
  stdout.

### Changed

- Document how agents should handle ambiguous MCP disconnects after
  `apply_recipe` and treat Calavera-managed dry-run files as apply-owned
  outputs.

## 2.0.4

### Added

- Document Claude Code MCP registration with project-scoped `.mcp.json`,
  `claude mcp add`, and explicit approval guidance for persistent `npx`
  execution.

## 2.0.3

### Fixed

- Start the MCP server when `create-project-calavera-mcp` is launched through a
  package-manager bin symlink.
- Remove the standalone Calavera marker from appended `AGENTS.md` guidance
  sections.

## 2.0.2

### Added

- Ask interactive agent bootstrap users before appending marked Calavera
  guidance to an existing `AGENTS.md`, with `--agents-md=append|fallback` for
  scripted runs.

### Changed

- Keep existing non-interactive `AGENTS.md` handling non-destructive by writing
  Calavera guidance to `AGENTS.calavera.md` unless append mode is explicit.

## 2.0.1

### Fixed

- Run the CLI entry point correctly when launched through package-manager
  shims, including `bunx create-project-calavera --init`.
- Accept forwarded `-- --init` argument separators for agent bootstrap.
- Make agent bootstrap output clearer about written or skipped files.

## 2.0.0

This release completes the agent-first Calavera composition milestone tracked in
[#204](https://github.com/schalkneethling/create-project-calavera/issues/204).
Calavera is now centered on project-agnostic recipe composition for existing or
newly scaffolded projects, with agents, the CLI, and the web composer sharing
the same recipe model.

### Added

- Shared recipe composition core for profiles, package managers, integrations,
  AI artifacts, validation, and explanation.
- Standard MCP server for agent-native recipe composition, dry-run previews,
  and approved applies.
- WebMCP recipe composition parity in the browser, with browser-safe recipe
  download instead of filesystem apply.
- Agent bootstrap flow that installs Calavera guidance, MCP setup notes, and
  the bundled Calavera skill without scaffolding app code.
- Rich interactive CLI composer for profile, integration, package-manager, and
  AI artifact selection.
- Web composer next-command guidance for optional agent bootstrap, dry-run
  review, and approved apply.
- Agent-first workflow documentation covering MCP, WebMCP, rich CLI, web UI,
  Vite+, other scaffolds, and existing projects.

### Changed

- Calavera's documented direction now treats application scaffolding as out of
  scope and keeps Vite+ or other generators separate from recipe composition and
  apply.
- Release docs now describe the 2.0.0 trusted-publishing path and the checks to
  run before creating the GitHub release.

### Migration Notes

- Existing `calavera.config.json` files using recipe schema version `1` remain
  valid.
- Existing projects should preview changes before approving an apply:
  - CLI: `create-project-calavera apply --dry-run`
  - MCP: `dry_run_apply`
- `init` composes `calavera.config.json`; `--init` bootstraps agent guidance.
  With `npm create`, pass the bootstrap flag as
  `npm create project-calavera -- --init`.
