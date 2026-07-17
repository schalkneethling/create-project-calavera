# create-project-calavera

[![skills.sh](https://skills.sh/b/schalkneethling/create-project-calavera)](https://skills.sh/schalkneethling/create-project-calavera)

[Project Calavera](https://github.com/schalkneethling/create-project-calavera/)
is an open-source CLI tool that scaffolds linters, formatters, TypeScript
configs, AI tooling such as agent skills, hooks, and subagents, and other common
project infrastructure for web projects. It works standalone for vanilla
JavaScript, TypeScript, and library projects, and it works as a complement to
framework scaffolding tools like Vite+ and `vp create`, giving any project a
consistent, repeatable setup through a single recipe file.

## MCP-First Agent Flow

Use Calavera after a project already exists, whether it came from `vp create`,
Vite, another scaffold tool, or a manually maintained repository:

1. Open the project directory.
2. Run `npm create project-calavera -- --init`.
3. Choose exactly one project-local MCP host when prompted: Claude Code, Codex,
   Cursor, OpenCode, or skip/manual.
4. Restart or reload the agent session if your MCP host does not discover new tools dynamically.
5. Confirm the Calavera MCP tools are exposed: `inspect_project`, `list_profiles`, `list_integrations`, `list_ai_artifacts`, `compose_recipe`, `validate_recipe`, `explain_recipe`, `dry_run_apply`, and `apply_recipe`.
6. Start the agent from the project root.
7. Agent prompt: `Use Calavera for this project. First verify that the Calavera MCP tools are available. If they are not available, stop and help me configure the MCP server before composing or applying anything. Once the tools are available, inspect the current project for existing tooling and possible config conflicts, list the available profiles, integrations, and AI artifacts, compose a recipe, validate and explain it, show me the dry-run result, and apply it only after I approve.`

Find the equivalent commands for your package manager in the
[agent-first command table](#agent-first-command-table).

### Agent-First Command Table

| Package manager | Bootstrap agent guidance                  | Preview apply                                      | Apply recipe                             |
| --------------- | ----------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| npm             | `npm create project-calavera -- --init`   | `npm create project-calavera apply -- --dry-run`   | `npm create project-calavera apply`      |
| pnpm            | `pnpm dlx create-project-calavera --init` | `pnpm dlx create-project-calavera apply --dry-run` | `pnpm dlx create-project-calavera apply` |
| Yarn            | `yarn dlx create-project-calavera --init` | `yarn dlx create-project-calavera apply --dry-run` | `yarn dlx create-project-calavera apply` |
| Bun             | `bunx create-project-calavera --init`     | `bunx create-project-calavera apply --dry-run`     | `bunx create-project-calavera apply`     |

`npm create` needs the `--` separator before Calavera flags such as `--init`
and `--dry-run`. Do not use `npm create project-calavera --init`; npm treats
`--init` as its own option and Calavera falls back to the recipe CLI. Yarn
requires Yarn 2+ for `dlx`; Yarn 1.x users can use
`npx --package create-project-calavera create-project-calavera --init`.
Direct binary launchers such as `npx --package` do not need an extra `--` before
Calavera flags: use
`npx --package create-project-calavera create-project-calavera --help`, not
`npx --package create-project-calavera create-project-calavera -- --help`.
MCP server registrations launch `create-project-calavera-mcp` directly and
should not add `--help`.

Agents should treat `dry_run_apply` as the approval boundary. They should show
the package manager, integrations, dependency packages, inspection findings,
omitted script explanations, ownership notes, file changes, and AI artifact
changes before calling `apply_recipe`.
If MCP tools are not exposed, agents should configure or repair MCP setup first;
they should not inspect npm cache internals or import Calavera source files from
package cache paths as a substitute for MCP setup.

Choose one formatter for the project. Calavera rejects recipes that include both
Oxfmt and Prettier because they would compete for the same formatting scripts
and config ownership.

If the agent finds likely conflicts, it should pause and list whether each one
is a hard stop or a migration decision the user can still approve. A dry run is
the best next step when adoption is still possible and the user wants to see the
impact.

Compose the recipe yourself with the interactive CLI:

```bash
npm create project-calavera init
npm create project-calavera apply -- --dry-run
npm create project-calavera apply
```

`init` composes `calavera.config.json`; `-- --init` bootstraps agent guidance.

Use the web UI when you prefer browser composition. Save or download
`calavera.config.json`, then run the displayed package-manager command from the
project folder that contains the saved file.

See
[`docs/agent-first-calavera-workflow.md`](docs/agent-first-calavera-workflow.md)
for agent, CLI, web UI, MCP/WebMCP, Vite+, other scaffold, and existing-project
examples.

### Bun-managed projects and npm `devEngines`

Some starters declare Bun in `devEngines.packageManager`. npm 11 fails before
Calavera can run when `npm create` is used from one of those projects:

```text
Invalid devEngines.packageManager
Invalid name "bun" does not match "npm" for "packageManager"
```

Use the package manager declared by the project instead:

```bash
bunx create-project-calavera apply
```

The same rule applies to manual MCP server registration. Use
`bunx --package create-project-calavera@<version> create-project-calavera-mcp`
instead of `npx --package create-project-calavera@<version> create-project-calavera-mcp`
when the agent harness launches Calavera from a Bun-managed project root. The
explicit version avoids Bun dropping the non-default `create-project-calavera-mcp`
bin during ad-hoc `--package` resolution and keeps every persistent MCP
registration from floating to a later package release.

If `bunx` reports `error: bun is unable to write files to tempdir:
PermissionDenied` in a restricted agent or MCP sandbox, configure the MCP host to
set `TMPDIR` to an absolute writable directory. If Bun's package cache is also
blocked, set `BUN_INSTALL_CACHE_DIR` to an absolute writable cache directory for
that server registration.

If you intentionally want to launch through npm anyway, npm requires `--force`
to bypass its own `devEngines` preflight:

```bash
npm --force create project-calavera apply
```

## What Calavera Manages

- Linting and formatting tools
- TypeScript config with JavaScript and TypeScript type checking
- Stylelint and CSS quality plugins
- AI skills, hooks, and agents under `.agents/`
- `package.json` scripts
- A repeatable `calavera.config.json` recipe

Editor extensions, global apps, shell setup, and machine-level configuration are
out of scope. Install the matching editor integrations for your development
environment of choice.

## Profiles

- **Modern**: Oxlint, Oxfmt, Stylelint, TypeScript
- **Classic**: ESLint flat config, Prettier, Stylelint, TypeScript
- **Minimal**: EditorConfig only

When the TypeScript integration is selected, Calavera generates a `tsconfig.json`
that can check `.js`, `.jsx`, `.ts`, and `.tsx` files. JavaScript files can opt
into checking with `// @ts-check` and JSDoc annotations.

## Integration Catalog

Calavera includes curated integration packs grouped by outcome:

- React best practices
- Imports and modules
- Promise safety
- Node package rules
- Test rules
- CSS Baseline
- CSS property ordering
- CSS property type validation

React best-practice checks can include React Doctor, a deterministic scanner for
React codebases that complements linting with security, performance,
correctness, accessibility, bundle-size, and architecture diagnostics. JSX-A11y
linting also appears with the React checks because it targets JSX markup.

The CSS catalog includes `stylelint-plugin-logical-css` for logical CSS
property, value, and unit checks, plus
`@schalkneethling/stylelint-plugin-css-property-type-validator` as a curated
experimental integration.

Adding a new integration should be a catalog-first change. For example, a
Stylelint plugin entry can declare its package dependency, parent `stylelint`
integration, plugin name, and default rules in `packages/cli/src/catalog.js`; the CLI then
uses that metadata when generating `.stylelintrc.json`.

See
[`docs/contributing-calavera-integration-varlock.md`](docs/contributing-calavera-integration-varlock.md)
for a draft contributor walkthrough based on Theo Ephraim's Varlock integration.

## CLI

Create a recipe:

```bash
npm create project-calavera init
```

The interactive recipe composer lets you choose a profile, package manager,
integration packs, and bundled AI artifacts. By default it only writes
`calavera.config.json`.

Run `init` without selection flags for guided prompts that present the available
options. Use selection flags only for scripted or CI flows:

```bash
npm create project-calavera init -- --profile modern --package-manager pnpm --tool oxlint --tool stylelint
```

Wrap labels that contain spaces in quotes, for example
`--tool "Oxc React best practices"`. Prefer ids such as `oxlint-react` in
scripts and CI so commands stay copy-pastable.

Apply a recipe:

```bash
npm create project-calavera apply
```

Inspect the current project:

```bash
npm create project-calavera doctor
```

Update managed tooling from the recipe:

```bash
npm create project-calavera update
```

Remove stale managed files:

```bash
npm create project-calavera clean
```

Inspect machine-readable output for agent workflows:

```bash
npm create project-calavera doctor --json
npm create project-calavera apply -- --dry-run --json
```

Bootstrap an existing project for agent-first Calavera usage without
scaffolding app code:

```bash
npm create project-calavera -- --init
```

`npm create` needs the `--` separator before Calavera flags. Do not use
`npm create project-calavera --init`; npm treats `--init` as its own option and
Calavera falls back to the recipe CLI. With other package managers, use
`pnpm dlx create-project-calavera --init`,
`yarn dlx create-project-calavera --init`, or
`bunx create-project-calavera --init`.
The Yarn command requires Yarn 2+ because Yarn 1.x does not support `dlx`; Yarn
1.x users can use `npx --package create-project-calavera create-project-calavera --init`
or install `create-project-calavera` globally.

The `--init` bootstrap installs the base Calavera skill, adds concise project
guidance, optionally writes one project-local MCP config, and prints a
recommended first prompt for the user to give their agent. It writes MCP setup
notes only when the user chooses skip/manual or project-local MCP config cannot
be written. When `AGENTS.md` already exists, interactive runs ask whether to
append marked Calavera guidance directly to that file or leave it unchanged and
write fallback guidance to `AGENTS.calavera.md`. Scripted runs keep the
fallback-only behavior unless `--agents-md=append` is passed.

## MCP Server

Calavera also ships a standard MCP server for agent-native recipe composition:

```bash
npx --package create-project-calavera@<version> create-project-calavera-mcp
```

During `--init`, Calavera can write one project-local MCP config for Claude
Code, Codex, Cursor, or OpenCode. It never writes global/user MCP config. It
writes `.agents/calavera/mcp.md` only when you choose `skip` or the selected
local config cannot be written.

Project-local config targets:

- Claude Code: `.mcp.json`
- Codex: `.codex/config.toml`
- Cursor: `.cursor/mcp.json`
- OpenCode: `opencode.json`

Use the package manager declared by the target project's `package.json`.
When configuring MCP manually, choose the matching command and put the first
word in the MCP `command` field and the remaining words in `args`:

- npm: `npx --package create-project-calavera@<version> create-project-calavera-mcp`
- pnpm: `pnpm dlx --package create-project-calavera@<version> create-project-calavera-mcp`
- Yarn: `yarn dlx --package create-project-calavera@<version> create-project-calavera-mcp`
- Bun: `bunx --package create-project-calavera@<version> create-project-calavera-mcp`

JSON-based MCP hosts use this shape:

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

Codex uses TOML:

```toml
[mcp_servers.calavera]
command = "npx"
args = ["--package", "create-project-calavera@<version>", "create-project-calavera-mcp"]
```

OpenCode stores local MCP servers under `mcp`:

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

Project-local MCP servers run from the project root. Matching the project
package manager prevents package-manager preflight failures before Calavera can
start, such as npm 11 rejecting a Bun-managed project through
`devEngines.packageManager`.

When a restricted MCP host launches the Bun command, Bun may fail before
Calavera starts with `error: bun is unable to write files to tempdir:
PermissionDenied`. Configure that MCP server environment with `TMPDIR` set to an
absolute writable directory, such as an absolute path to a project-local
`.calavera/tmp` directory.
If the package cache is also restricted, set `BUN_INSTALL_CACHE_DIR` to an
absolute writable directory such as an absolute path to
`.calavera/bun-install-cache`. Keep these as Bun-only recovery settings rather
than default MCP config.

Agent guidance should tell the harness to use Calavera when a user wants to
inspect available project tooling, compose `calavera.config.json`, preview a
Calavera apply run, or apply an approved recipe. An MCP client can use the tools
in this order:

1. `inspect_project`
2. `list_profiles`
3. `list_integrations`
4. `describe_integration`
5. `list_ai_artifacts`
6. `compose_recipe`
7. `validate_recipe`
8. `explain_recipe`
9. `dry_run_apply`
10. `apply_recipe`

`dry_run_apply` returns structured JSON with the package manager, integrations,
dependency packages, project inspection findings, omitted script explanations,
file ownership/action notes, and AI artifact changes that would be made. Agents
should present that dry-run summary to the user first. `apply_recipe` is
intentionally the approval boundary: call it only after the user explicitly
approves the proposed recipe and dry-run result.

## Common Flags

- `--config calavera.config.json`
- `--profile modern|classic|minimal`
- `--package-manager npm|pnpm|yarn|bun`
- `--integration <id-or-label>` or `--tool <id-or-label>` for scripted
  composition; quote labels with spaces, or use ids/slugs in scripts and CI
- `--ai-artifact <id-or-label-or-source>`; use `<artifact>@<target>` for hook
  and agent targets, or omit this flag to select from the interactive option list
- `--agents-md append|fallback` with `--init` to script how existing `AGENTS.md`
  files are handled
- `--mcp-harness claude-code|codex|cursor|opencode|skip` with `--init` to
  script project-local MCP auto-config
- `--apply` with `init` to preview and then confirm applying the composed recipe
- `--dry-run`
- `--no-install`
- `--yes`
- `--json`

## Vite+ And Delta Workflows

Calavera keeps generated package scripts as ordinary tool commands. It can add
tooling, configuration, dependencies, and package scripts, but delta execution
belongs to tool-native options, project-specific scripts, Vite+/`vp`, or CI
workflow logic rather than a Calavera changed-file wrapper.

See [`docs/vite-plus-and-delta-mode.md`](docs/vite-plus-and-delta-mode.md) for
the Vite+ design boundary and delta workflow guidance.

## Template And Agent Composition

A future `@schalkneethling/create` package may collapse Vite+ scaffolding,
Calavera recipe composition, Calavera apply, and project startup into a single
creation path. It should remain separate from Calavera's tooling-composition
responsibilities.

Calavera exposes agent-native recipe composition through the standard MCP server
and browser-safe recipe composition through WebMCP, so coding agents can compose
recipes directly instead of driving the human web UI.

See
[`docs/create-template-and-agent-composition.md`](docs/create-template-and-agent-composition.md)
for the current boundary, research questions, and phase-two handoff plan.

## Recipe Schema

Generated recipes reference the public draft 2020-12 schema at
[`https://calavera.schalkneethling.com/calavera.config.schema.json`](https://calavera.schalkneethling.com/calavera.config.schema.json).
The maintained schema lives at `apps/composer/public/calavera.config.schema.json` so it is
published with the web composer.

## AI Artifacts

Calavera can install bundled AI skills, hooks, and agents from the optional
`ai` section in `calavera.config.json`. The `ai` key is a composed list of AI
artifacts, whether it was written by hand or generated by the CLI, Web UI, or an
agent workflow.

Define the exact artifact items to include:

```json
{
  "ai": [
    { "type": "skill", "src": "skills/frontend-engineering" },
    {
      "type": "hook",
      "src": "hooks/block-dangerous-commands",
      "target": "claude-code"
    }
  ]
}
```

Skills install into `.agents/skills/`. Hook and agent items can set `target` to
choose their `.agents/hooks/<target>/` or `.agents/agents/<target>/` directory.
The current bundled hooks and agents come from `claude-toolkit` and default to
`claude-code`.

Set an agent item's `target` to `codex` when you want Calavera to generate a
Codex custom-agent TOML file under `.codex/agents/` instead of preserving the
source Markdown under `.agents/agents/<target>/`.

Calavera owns the managed AI files it writes, including canonical `.agents/`
artifacts and Codex-adapted `.codex/agents/` files. Other vendor tools may need
their own settings, symlinks, or import step before they consume those files. See
[`docs/ai-adapter-guidance.md`](docs/ai-adapter-guidance.md) for Claude Code,
Codex, and other agent-tool guidance.

### skills.sh Discovery

Calavera's bundled skills are grouped for discovery on
[`skills.sh`](https://skills.sh/schalkneethling/create-project-calavera). Use
the directory page, badge, or `skills` CLI listing flow to inspect available
skills before choosing what belongs in a project.

For Calavera-managed projects, prefer selecting bundled skills through
`calavera.config.json`, the interactive AI artifact prompt, or scripted
`--ai-artifact` flags. That keeps installed skills tracked in
`.calavera/state.json`, covered by dry runs, and protected by Calavera's
overwrite checks.

Direct installs with `npx skills add schalkneethling/create-project-calavera`
can be useful for one-off discovery or non-Calavera workflows, but those files
are managed by the `skills` CLI rather than Calavera. Do not mix direct installs
and Calavera-managed installs for the same destination unless you intentionally
want Calavera to treat the existing files as local, unmanaged content.

## Web Composer

The recipe composer runs as a small Vite app:

```bash
npm run web:dev
```

> **Note**: You can also access the UI via [https://calavera.schalkneethling.com](https://calavera.schalkneethling.com)

Open the printed local URL, choose your packs, then either:

- save `calavera.config.json` directly with the browser file picker, or
- download `calavera.config.json`.

Both options are shown by default so users can choose the flow they are most
comfortable with. After saving the file, run the displayed next commands from
the project folder that contains `calavera.config.json`. The optional bootstrap
command prepares agent guidance; the dry-run command previews local changes; the
apply command writes approved changes.

When the browser exposes WebMCP, the composer registers a browser parity surface
for the MCP recipe composition workflow:

1. `list_profiles`
2. `list_integrations`
3. `describe_integration`
4. `list_ai_artifacts`
5. `list_baseline_targets`
6. `describe_baseline_target`
7. `search_baseline_features`
8. `recommend_baseline_target`
9. `compose_recipe`
10. `validate_recipe`
11. `explain_recipe`
12. `download_recipe`

WebMCP uses the same shared recipe composition model as the standard MCP server,
but it cannot inspect, dry-run, or apply files in a local project workspace from
the browser. Use `download_recipe` to save `calavera.config.json`, then apply it
with the CLI or standard MCP server from the project root.

Build the composer with:

```bash
npm run web:build
```

## Baseline targets

The independently deployable Baseline Target Explorer explains Widely, Newly, and fixed-year targets, shows the matching Chrome, Edge, Firefox, and Safari versions, and recommends the earliest fixed target for selected CSS features.

Recipes keep integrations as string IDs and carry optional integration-specific settings separately:

```json
{
  "integrations": ["stylelint-baseline"],
  "integrationOptions": {
    "stylelint-baseline": {
      "available": 2025,
      "severity": "warning"
    }
  }
}
```

`available` accepts `"widely"`, `"newly"`, or a supported fixed year. `severity` accepts `"warning"` or `"error"`. Options are rejected unless their integration is selected, and existing recipes without `integrationOptions` retain their previous Stylelint behavior.

Build the Explorer independently with:

```bash
pnpm --filter @calavera/baseline-explorer build
```

## Versioned artifacts

New recipes select package-backed skills, hooks, and agents by stable ID:

```json
{
  "ai": [
    { "id": "skill-project-goal" },
    { "id": "agent-technical-devils-advocate", "target": "codex" }
  ]
}
```

Legacy `{ "type", "src", "target" }` entries remain readable during the compatibility window. Migrate and manage exact versions with:

```bash
create-project-calavera artifacts migrate
create-project-calavera artifacts install
create-project-calavera artifacts status
create-project-calavera artifacts status --check-updates
create-project-calavera artifacts doctor
create-project-calavera artifacts update skill-project-goal
create-project-calavera artifacts update --all --tag next
```

Installation resolves npm packages into `.calavera/packages` and a verified npm cache without changing consumer `package.json` or `node_modules`. `.calavera/artifacts.lock.json` records exact versions, integrity, destinations, and payload hashes; ordinary `apply` requires and reuses those exact locked versions. Only `artifacts update` advances a version. Status is offline unless `--check-updates` is explicit. Run `artifacts doctor` to verify installed outputs, managed state, and local edits without checking the registry. The existing managed-state hashes continue to block overwriting local edits.

## macOS update companion

The optional Calavera menu-bar app monitors only project directories that you explicitly register. It reads recipes, artifact locks, and state without changing them; checks npm and GitHub on launch and every six hours; and deduplicates notifications by component and target version.

For project updates, the app copies the exact command and opens Terminal at the registered directory. It never executes the command. App updates open a stable GitHub release, and self-updating is intentionally outside v1.

Local development requires Node.js, pnpm, Rust through rustup, and Xcode:

```bash
pnpm --filter @calavera/menu-bar dev
```

Tags matching `menu-bar-v*` run the independent macOS release workflow, which builds a universal signed, notarized, and stapled DMG through the protected `publish` environment.

## Publishing

Calavera publishes to npm from GitHub releases with npm trusted publishing. The
repository workflow is `.github/workflows/publish.yml`, and npm should be
configured with that workflow as a trusted publisher for
`create-project-calavera` and each public workspace package, including
`@schalkneethling/calavera-baseline-core`.

Before the first trusted publish:

- enable 2FA on npm and GitHub;
- remove any `NPM_TOKEN` repository secret;
- create a GitHub environment named `publish` and restrict it to `main`;
- configure npm trusted publishing for this repository, workflow, and
  environment.

To validate the package locally, first install
[`uv`](https://docs.astral.sh/uv/getting-started/installation/). It provisions
the locked Python environment used by SkillSpector and the workflow audit.
`pnpm workflow:check` runs `uvx zizmor@1.25.2 --offline`, so prime that exact
version in uv's cache once while online before using the offline check.

```bash
uv sync --frozen
uvx zizmor@1.25.2 --version
pnpm check
pnpm web:build
pnpm publish:check
pnpm pack --dry-run
pnpm workflow:check
```

For the 2.0.0 release, create tag `v2.0.0` from `main`, draft a GitHub release
for that tag, and use [`CHANGELOG.md`](CHANGELOG.md) as the starting release
notes. Publishing the GitHub release triggers the trusted-publishing workflow.

The publish workflow checks the project, builds the web composer, packs the
package, audits the workflow with [zizmor](https://zizmor.sh), then publishes
the packed tarball with npm provenance.
