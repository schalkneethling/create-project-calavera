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
different lint, format, or typecheck command. The one exception is the
aggregate `quality` script: in a Vite+-managed project it runs `vp check` and
the Vite+ test step before Calavera's own scripts, and no other generated script
calls `vp` ([ADR-0013](adr/0013-quality-runs-vite-plus-checks.md)). If
Vite+-specific behavior becomes useful later, it should be modeled as an
explicit catalog integration so the CLI and composer can expose it
consistently.

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

The one exception, a wrapper around a tool, is `scripts/lint-html.mjs`, which
`lint:html` runs (issue #644). It is not a delta runner and does not filter file lists:
`html-validate` exits with an error when no file matches and has no option to
allow empty input, so a project without static HTML files would fail
`lint:html`. The wrapper asks HTML Validate's own file expansion whether any
file matches. When none does, it exits successfully without running
`html-validate`. Otherwise, it runs `html-validate` with the same arguments and
exit code, and with any option, such as `--stdin` or `--ext`, it runs
`html-validate` directly. The reasons Calavera stopped generating
`.calavera/run-if-files.mjs` (issue #241) do not apply, because the wrapper
passes no file list of its own. Remove the wrapper, and generate
`html-validate` directly in `lint:html`, when `html-validate` gains an option
that allows empty input, as Stylelint's `--allow-empty-input` does.
