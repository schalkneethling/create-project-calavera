# create-project-calavera

[Project Calavera](https://github.com/schalkneethling/create-project-calavera/)
is an open-source CLI tool that scaffolds linters, formatters, TypeScript
configs, AI tooling such as agent skills, hooks, and subagents, and other common
project infrastructure for web projects. It works standalone for vanilla
JavaScript, TypeScript, and library projects, and it works as a complement to
framework scaffolding tools like Vite+ and `vp create`, giving any project a
consistent, repeatable setup through a single recipe file.

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
- Accessibility
- Imports and modules
- Promise safety
- Node package rules
- Test rules
- CSS Baseline
- CSS property ordering
- CSS property type validation

React best-practice checks can include React Doctor, a deterministic scanner for
React codebases that complements linting with security, performance,
correctness, accessibility, bundle-size, and architecture diagnostics.

The CSS catalog includes
`@schalkneethling/stylelint-plugin-css-property-type-validator` as a curated
experimental integration.

Adding a new integration should be a catalog-first change. For example, a
Stylelint plugin entry can declare its package dependency, parent `stylelint`
integration, plugin name, and default rules in `src/catalog.js`; the CLI then
uses that metadata when generating `.stylelintrc.json`.

See
[`docs/contributing-calavera-integration-varlock.md`](docs/contributing-calavera-integration-varlock.md)
for a draft contributor walkthrough based on Theo Ephraim's Varlock integration.

## CLI

Create a recipe:

```bash
npm create project-calavera init
```

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
npm create project-calavera apply --dry-run --json
```

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

If you intentionally want to launch through npm anyway, npm requires `--force`
to bypass its own `devEngines` preflight:

```bash
npm --force create project-calavera apply
```

## Common Flags

- `--config calavera.config.json`
- `--profile modern|classic|minimal`
- `--package-manager npm|pnpm|yarn|bun`
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

Calavera should also expose agent-native recipe composition through WebMCP and,
if needed, a standard MCP server so coding agents can compose recipes directly
instead of driving the human web UI.

See
[`docs/create-template-and-agent-composition.md`](docs/create-template-and-agent-composition.md)
for the current boundary, research questions, and phase-two handoff plan.

## Recipe Schema

Generated recipes reference the public draft 2020-12 schema at
[`https://calavera.schalkneethling.com/calavera.config.schema.json`](https://calavera.schalkneethling.com/calavera.config.schema.json).
The maintained schema lives at `web/public/calavera.config.schema.json` so it is
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
comfortable with.

Build the composer with:

```bash
npm run web:build
```

## Publishing

Calavera publishes to npm from GitHub releases with npm trusted publishing. The
repository workflow is `.github/workflows/publish.yml`, and npm should be
configured with that workflow as a trusted publisher for
`create-project-calavera`.

Before the first trusted publish:

- enable 2FA on npm and GitHub;
- remove any `NPM_TOKEN` repository secret;
- create a GitHub environment named `publish` and restrict it to `main`;
- configure npm trusted publishing for this repository, workflow, and
  environment.

To validate the package locally:

```bash
pnpm publish:check
pnpm pack --dry-run
pnpm workflow:check
```

Create a release by tagging the version and publishing a GitHub release for that
tag. The publish workflow checks the project, builds the web composer, packs the
package, audits the workflow with [zizmor](https://zizmor.sh), then publishes the packed tarball with
npm provenance.
