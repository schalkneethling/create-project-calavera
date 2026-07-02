# Agent-First Calavera Workflow

Calavera starts after a project folder exists. Create the app with Vite, Vite+,
another scaffold, or no scaffold at all, then use Calavera to compose, review,
and apply project tooling through a recipe.

Calavera deliberately does not own application scaffolding. It owns
`calavera.config.json`, generated tooling config, package scripts, AI artifacts,
managed state, `doctor`, `update`, `clean`, and apply dry-run output. Vite+ and
other starters own routes, components, framework files, starter dependencies,
and project-specific app commands.

## Recommended Agent Flow

From the project root:

```bash
npm create project-calavera -- --init
```

`npm create` needs the `--` separator before Calavera flags such as `--init`.
The other package-manager launchers run the Calavera binary directly, so their
bootstrap commands are `pnpm dlx create-project-calavera --init`,
`yarn dlx create-project-calavera --init`, and
`bunx create-project-calavera --init`.
See [Package-Manager Commands](#package-manager-commands) below for the full
command table.

The bootstrap writes Calavera guidance for agents, MCP setup notes, and the base
Calavera skill. It does not scaffold app code. When `AGENTS.md` already exists,
interactive runs ask whether to append marked Calavera guidance directly to that
file or write `AGENTS.calavera.md` for manual merging. Scripted runs keep
`AGENTS.md` unchanged unless `--agents-md=append` is passed.

Register the MCP server from the generated `.agents/calavera/mcp.md` notes:

```json
{
  "mcpServers": {
    "calavera": {
      "command": "npx",
      "args": ["--package", "create-project-calavera@<version>", "create-project-calavera-mcp"]
    }
  }
}
```

Use the package manager declared by the target project's `package.json` when
creating the MCP registration. The generated notes choose the matching command,
such as `npx` for npm-managed projects, `pnpm dlx` for pnpm, `yarn dlx` for
Yarn, or `bunx` for Bun. Project-scoped MCP servers run from the project root,
so matching the package manager avoids preflight failures before Calavera can
start.

For manual MCP setup, choose the matching command and split it into the harness
configuration fields:

- npm: `npx --package create-project-calavera@<version> create-project-calavera-mcp`
- pnpm: `pnpm dlx --package create-project-calavera@<version> create-project-calavera-mcp`
- Yarn: `yarn dlx --package create-project-calavera@<version> create-project-calavera-mcp`
- Bun: `bunx --package create-project-calavera@<version> create-project-calavera-mcp`

In JSON-based MCP configs, the first word becomes `command` and the remaining
words become `args`.
Keep an explicit package version specifier so package-manager launchers resolve
the `create-project-calavera-mcp` bin reliably without making the persistent MCP
registration float to a later package release.

For Claude Code, prefer a project-scoped `.mcp.json` in the project root when
the team should share the registration. Do not put MCP server registrations in
`.claude/settings.json`; Claude Code does not load MCP servers from that file.
`claude mcp add` can also register the same command if you want Claude Code to
manage the entry. Because the server command runs an external package, Claude
Code may require explicit approval before creating the persistent registration
or launching the server for the first time.

Then ask the agent to inspect the project before composing a recipe:

```text
Use Calavera for this project. Inspect the current project for existing tooling and possible config conflicts, then list the available profiles, integrations, and AI artifacts. Once the profile and requirements are clear, compose a recipe, show me the dry-run result, and apply it only after I approve.
```

The approval boundary is the dry run. Agents should call `dry_run_apply`, show
the proposed file changes, package scripts, dependencies, and AI artifacts, then
call `apply_recipe` only after explicit approval.
If the MCP transport closes or reports `-32000` during or immediately after
`apply_recipe`, agents should treat the apply outcome as unknown instead of
failed. Inspect `calavera.config.json`, `.calavera/state.json`, generated files,
and package metadata before retrying the apply.
Files listed by `dry_run_apply` are Calavera-managed outputs. Agents should not
hand-write or edit them; `apply_recipe` or `create-project-calavera apply`
creates them after approval.

If inspection finds likely conflicts, the agent should pause before applying
changes and list each conflict as either a hard stop or a migration decision the
user can still approve. When adoption still looks possible, use `dry_run_apply`
to show the concrete impact before asking whether to continue.

## Rich CLI Flow

Use the interactive CLI when you want to choose the profile, integrations,
package manager, and bundled AI artifacts yourself:

```bash
npm create project-calavera init
```

That writes `calavera.config.json`. Review the file, then preview and apply from
the same project root:

```bash
npm create project-calavera apply -- --dry-run
npm create project-calavera apply
```

For scripted composition, pass ids or labels:

```bash
npm create project-calavera init -- --profile modern --package-manager pnpm --tool oxlint --tool stylelint
```

`init` is the recipe composer. `--init` is the agent bootstrap flag. The names
are close because npm create treats `init` as the package command and requires
`-- --init` when forwarding a flag to the package.

## Web UI Flow

Use the hosted composer or local Vite app when you prefer a browser surface:

- Hosted: [https://calavera.schalkneethling.com](https://calavera.schalkneethling.com)
- Local: `npm run web:dev`

Choose a profile, package manager, integrations, and AI artifacts. Save or
download `calavera.config.json`, move it into the project root if needed, then
run the displayed package-manager command from that project folder.

The browser can compose and download recipes. It cannot inspect your local
project, dry-run filesystem changes, install dependencies, or apply the recipe.
Use the CLI or standard MCP server for those project-local steps.

## Package-Manager Commands

Use the package manager you selected for the recipe:

| Package manager | Optional agent bootstrap                  | Preview saved recipe                               | Apply approved recipe                    |
| --------------- | ----------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| npm             | `npm create project-calavera -- --init`   | `npm create project-calavera apply -- --dry-run`   | `npm create project-calavera apply`      |
| pnpm            | `pnpm dlx create-project-calavera --init` | `pnpm dlx create-project-calavera apply --dry-run` | `pnpm dlx create-project-calavera apply` |
| Yarn            | `yarn dlx create-project-calavera --init` | `yarn dlx create-project-calavera apply --dry-run` | `yarn dlx create-project-calavera apply` |
| Bun             | `bunx create-project-calavera --init`     | `bunx create-project-calavera apply --dry-run`     | `bunx create-project-calavera apply`     |

Run these commands from the folder that contains `calavera.config.json`.
Bootstrap is optional and useful for agent-led work. The dry run is the review
step. Apply is the step that writes files and may install dependencies. The
extra `--` appears only in npm commands because npm create needs it before
forwarded flags; the `dlx` and `bunx` commands do not.

## MCP And WebMCP

The standard MCP server is the agent-native project workflow. It exposes
composition tools and project-local apply tools:

1. `list_profiles`
2. `list_integrations`
3. `describe_integration`
4. `list_ai_artifacts`
5. `compose_recipe`
6. `validate_recipe`
7. `explain_recipe`
8. `dry_run_apply`
9. `apply_recipe`

WebMCP exposes the browser-safe composition subset:

1. `list_profiles`
2. `list_integrations`
3. `describe_integration`
4. `list_ai_artifacts`
5. `compose_recipe`
6. `validate_recipe`
7. `explain_recipe`
8. `download_recipe`

Use standard MCP when the agent can run from the project root. Use WebMCP when
the agent is helping compose a recipe in the browser and the user will download
the file before applying it locally.

## Examples

New Vite project:

```bash
npm create vite@latest my-app
cd my-app
npm create project-calavera -- --init
```

New Vite+ project:

```bash
vp create
cd <created-project>
npm create project-calavera -- --init
```

Other scaffold or existing project:

```bash
cd <project-root>
npm create project-calavera -- --init
```

In every case, compose the recipe through an agent, the rich CLI, or the web UI;
review the dry-run output; then apply the approved recipe from the project root.

## Related Docs

- [README](../README.md)
- [AI adapter guidance](./ai-adapter-guidance.md)
- [Vite+ awareness and delta workflows](./vite-plus-and-delta-mode.md)
- [Template and agent composition path](./create-template-and-agent-composition.md)
