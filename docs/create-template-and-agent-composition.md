# @schalkneethling/create Template And Agent Composition Path

## Status

This is a phase-two planning document for
[#159 Define the @schalkneethling/create template path](https://github.com/schalkneethling/create-project-calavera/issues/159).

Phase one stays focused on Calavera's AI artifact apply pipeline. The
`@schalkneethling/create` template path should not block the Toolkit merge, and
Calavera should not take on application scaffolding while that path is being
designed.

## Decision Boundary

Calavera remains a tooling composer, not an application scaffold. A future
`@schalkneethling/create` package should not make Calavera own application
starter content. Its role is to collapse the current multi-step project creation
flow by orchestrating Vite+ scaffolding, Calavera recipe composition, Calavera
apply, and follow-up project commands.

The relationship should be:

- Vite+ and its selected starter own application scaffolding: framework choice,
  application files, routes, components, deployment starter shape, and
  template-specific app dependencies.
- `@schalkneethling/create` owns the single-command orchestration path: choosing
  or invoking the right Vite+ starter, getting a Calavera recipe, applying that
  recipe, and running the resulting project commands when supported.
- Calavera owns tooling composition: profiles, integrations, package scripts,
  generated tooling config, AI artifacts, schema validation, dry-run output,
  `doctor`, `update`, and `clean`.
- Shared intent crosses the boundary as a recipe, not as duplicated catalog
  logic or private Calavera internals.

## Working Shape

The expected shape is an npm package, working name `@schalkneethling/create`,
implemented as a Vite+ extension or template entry point. The goal is to
collapse this current flow:

```bash
vp create
# compose calavera.config.json through the web composer, CLI, or an agent
npm create project-calavera apply
# include AI artifacts through calavera.config.json
```

After Calavera's AI artifact phase lands, the AI artifact choices should already
be part of `calavera.config.json`. The remaining phase-two goal is collapsing
Vite+ scaffold selection, recipe composition, Calavera apply, and project
startup into one coherent creation path.

The ideal human workflow may become:

```bash
vp create @schalkneethling/create
```

The ideal agent workflow should be more direct:

```text
User intent
  -> coding agent
  -> agent chooses the @schalkneethling/create command to run
  -> agent gets a Calavera recipe through MCP or WebMCP
  -> generated calavera.config.json
  -> create-project-calavera apply
  -> install, check, and run project commands
```

The exact Vite+ command, package naming, extension manifest, template manifest,
and post-scaffold hook behavior are not yet verified. Do not design
implementation around inferred Vite+ APIs until the research spike below is
complete.

## Agent-Native Composition

WebMCP should not be treated as a second-class surface, and standard MCP should
be considered alongside it. Many Calavera users will already be working through
coding agents, and teaching those agents to drive a human UI is wasted effort
when recipe composition can be exposed as tools.

Fixed recipe defaults are useful for curated starting points, but they should
not be the only path. A coding agent should be able to ask Calavera what
profiles, integrations, AI artifacts, and package-manager choices exist, then
compose a recipe from natural-language project intent.

Candidate MCP and WebMCP capabilities:

- `list_profiles`
- `list_integrations`
- `describe_integration`
- `list_ai_artifacts`
- `compose_recipe`
- `validate_recipe`
- `explain_recipe`
- `write_recipe`
- `dry_run_apply`
- `doctor_project`

These capabilities should expose the same conceptual model as the CLI and web
composer. The catalog remains the source of truth; the UI, WebMCP, standard MCP,
and any future template package should not drift into separate product models.

## Phase-Two Research Spike

Before creating the real `@schalkneethling/create` package, do a focused Vite+
and agent-composition research spike.

Required research:

1. Read the current `voidzero-dev/vite-plus` template documentation and source
   around `vp create`.
2. Verify whether `createConfig.templates` exists, where it is declared, and
   what shape it accepts.
3. Verify whether `create.defaultTemplate` in `vite.config.ts` applies to
   external template packages.
4. Build a minimal external hello-world Vite+ extension or template package.
5. Confirm package naming expectations, such as `@scope/create`,
   `@scope/template`, or package-per-template names.
6. Confirm whether post-scaffold hooks or commands are supported.
7. Decide whether `create-project-calavera apply` can be chained automatically
   or must remain a documented second command.
8. Verify whether a Vite+ extension can call into an agent-assisted recipe
   composition flow, or whether the agent must orchestrate Vite+, MCP/WebMCP,
   and Calavera as separate tool calls.
9. Define how a standard MCP server and WebMCP surface should share recipe
   composition logic.
10. Decide whether `@schalkneethling/create` should include fixed recipe
    defaults, request an agent-composed recipe, or support both.
11. Document versioning implications: template package version, Calavera version
    pinning or floating, and how existing projects receive future recipe
    updates through Calavera rather than by rerunning a one-time scaffold.

Recommended research output:

```text
docs/vite-plus-template-research.md
```

That document should include verified examples from the minimal template
package, an explicit answer about post-scaffold commands, and a recommended
implementation plan for the template package and MCP/WebMCP composition
surfaces.

## Implementation Gate

Do not create the real template package until the research spike answers the
Vite+ extension questions. Once the mechanism is verified, the implementation
can choose among:

- a separate `schalkneethling/create` repository;
- a workspace package in this repository;
- one curated template package with multiple templates;
- multiple package-per-template entry points.

Whatever shape is chosen, the implementation should preserve Calavera's
non-goal of application scaffolding and keep recipe composition available to
agents through machine-native interfaces.
