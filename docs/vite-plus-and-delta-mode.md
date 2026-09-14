# Vite+ Awareness And Delta Workflows

Calavera remains a tooling composer, not an application scaffold. Vite+ awareness
should therefore live in catalog metadata and doctor guidance rather than in
generated scripts that assume a specific app starter or task runner.

## Vite+ Awareness

The authoritative answer to whether a project is managed by Vite+ comes from
one pure function, and `inspect_project` reports its result as the optional
`vitePlus` field and four stable finding kinds. The primary signal is a
`vite-plus` key under `dependencies` or `devDependencies` in the inspected
project's own `package.json` or the nearest ancestor manifest that declares
it, matched exactly as Vite+ matches it for its own self-check; see
[ADR-0001](./adr/0001-vite-plus-detection-signal.md) for the full signal set,
the corroborating signals, and the fixture table. Catalog metadata still
describes the project shapes an integration suits, and `doctor` stays
advisory:

- Catalog metadata should describe framework-specific integrations, including
  whether an integration is useful for Vite, Vite+, React, Vue, Svelte, or another
  project shape.
- `doctor` can surface advisory messages when a recipe and detected project files
  appear mismatched.

Generated package scripts should stay ordinary package-manager scripts. Calavera
should not replace them with `vp` commands or assume that a Vite+ project wants a
different lint, format, or typecheck command. If Vite+-specific behavior becomes
useful later, it should be modeled as an explicit catalog integration so the CLI
and composer can expose it consistently.

## Delta Workflows

Full-project lint, format, typecheck, and quality scripts remain the default.
Calavera should not generate changed-file runners or package scripts such as
`lint:changed`, `format:check:changed`, or `quality:changed`.

Calavera can install tools, write configuration, add dependencies, and add
ordinary package scripts that call those tools. From there, execution should be
delegated to the tool or project workflow itself. Delta execution belongs in:

- tool-native changed-file or cache-aware options;
- project-specific package scripts;
- Vite+/`vp` commands when a project explicitly adopts them;
- CI workflow logic that already knows the pull request base and changed paths.

Future support should only be added when a tool exposes a stable native delta
command that Calavera can call directly as that tool's documented interface.
Calavera should not filter file lists itself and pass them through as a
man-in-the-middle.
