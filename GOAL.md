# Project Goal

## North Star

Calavera helps web developers compose, apply, inspect, and refresh repeatable project tooling recipes without coupling those recipes to any one application framework or starter.

## Who This Is For

- Developers starting or maintaining web projects who want current linting, formatting, type-checking, and CSS-quality defaults without researching every tool from scratch.
- Maintainers who want a checked-in tooling recipe that can be re-applied as project tooling evolves.
- Agents and automation workflows that need deterministic CLI commands, dry runs, and JSON output when preparing or auditing project tooling.
- Users who prefer a visual composer for choosing profiles and integration packs before applying the generated recipe with the CLI.

## Core Goals

1. Provide clear tooling profiles.
   - `modern` should favor newer, fast tools such as Oxlint, Oxfmt, Stylelint, and TypeScript.
   - `classic` should favor widely adopted ESLint, Prettier, Stylelint, and TypeScript workflows.
   - `minimal` should stay intentionally small, currently focused on EditorConfig.

2. Make tooling configuration repeatable.
   - Store intent in `calavera.config.json`.
   - Generate managed config files, helper scripts, package scripts, and development dependencies from that recipe.
   - Track generated files in `.calavera/state.json` so stale managed files can be cleaned deliberately.

3. Keep integrations catalog-first.
   - Add or change integrations primarily through `src/catalog.js` metadata: dependencies, parent integrations, plugin names, status, and tool-specific config.
   - Let the CLI and web composer consume that catalog rather than duplicating behavior by hand.
   - Make experimental and framework-specific integrations visible as such.

4. Support safe inspection and automation.
   - Keep `doctor`, `apply --dry-run`, and `--json` output useful for humans, CI, and agents.
   - Prefer predictable file changes over hidden global state.
   - Make package-manager behavior explicit for npm, pnpm, yarn, and bun.

5. Offer a small web composer.
   - Let users choose profiles, package managers, and integration packs in the browser.
   - Export a valid `calavera.config.json` that the CLI can apply.
   - Expose WebMCP tools so capable agents can read options, configure the form, and download the recipe.

## Success Looks Like

- A user can run `npm create project-calavera init`, review or edit `calavera.config.json`, run `apply`, and get working lint, format, type-check, and CSS tooling scripts.
- `doctor`, `clean`, `update`, dry-run mode, and JSON mode give enough information to understand and automate changes before files are modified.
- Adding a new integration requires a small, understandable catalog update plus focused generation logic only when the target tool truly needs it.
- Generated files are readable, conventional, and easy to review, delete, or regenerate.
- The web composer and CLI expose the same conceptual choices, so users do not have to learn two different product models.
- The package can be validated, packed, and published through the existing secure npm trusted publishing workflow.

## Non-Goals

- Calavera is not an application scaffold. It should not generate app routes, components, business logic, UI systems, databases, or deployment-specific application code.
- Calavera is not a framework replacement or framework opinion engine. It may offer framework-specific tooling packs, but it should not decide whether a project uses Vite, Astro, Next.js, Bun, React, Vue, Svelte, or another starter.
- Calavera is not a machine setup tool. Editor extensions, global apps, shell profiles, operating-system packages, and developer workstation preferences are out of scope.
- Calavera should not become a hidden build system. It should generate ordinary project files and package scripts that remain understandable without Calavera running constantly in the background.
- Calavera should not optimize for every possible lint or formatting rule. Curated defaults, explicit optional packs, and maintainable catalog metadata matter more than exhaustive coverage.
- Calavera should not silently overwrite unrelated project intent. Managed files and scripts should be predictable, inspectable, and recoverable through dry runs and state.

## Principles and Constraints

- Prefer checked-in project configuration over global or implicit state.
- Preserve user agency: show choices, support dry runs, and make generated output easy to inspect.
- Keep defaults practical for real projects, with modern speed where stable enough and classic compatibility where users need it.
- Treat package-manager support as a first-class compatibility surface.
- Keep the CLI usable in both interactive and non-interactive contexts.
- Avoid coupling the catalog to the web UI in ways that make the CLI and composer drift.
- Be clear when an integration is recommended, optional, framework-specific, or experimental.
- Favor small, composable integration packs over large opaque presets.

## Current Focus

The current project centers on the recipe-driven CLI, the shared integration catalog, and the Vite-based Calavera Composer. Near-term work should preserve parity between the CLI and composer, improve generated tooling quality, and keep automation-friendly outputs stable.

The public draft 2020-12 recipe schema is maintained in `web/public/calavera.config.schema.json` and published with the composer at `https://calavera.schalkneethling.com/calavera.config.schema.json`.

## Open Questions

- None currently tracked.
