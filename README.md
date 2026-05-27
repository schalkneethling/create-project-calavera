# create-project-calavera

Compose and apply modern tooling recipes for web development projects.

Calavera is focused on project tooling, not application scaffolding. Use it in an
empty folder, or run it after scaffolding with Vite, Astro, Next.js, Bun, or any
other project starter.

## What Calavera Manages

- Linting and formatting tools
- TypeScript config
- Stylelint and CSS quality plugins
- `package.json` scripts
- A repeatable `calavera.config.json` recipe

Editor extensions, global apps, shell setup, and machine-level configuration are
out of scope. Install the matching editor integrations for your development
environment of choice.

## Profiles

- **Modern**: Oxlint, Oxfmt, Stylelint, TypeScript
- **Classic**: ESLint flat config, Prettier, Stylelint, TypeScript
- **Minimal**: EditorConfig only

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

## Common Flags

- `--config calavera.config.json`
- `--profile modern|classic|minimal`
- `--package-manager npm|pnpm|yarn|bun`
- `--dry-run`
- `--no-install`
- `--yes`
- `--json`

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
