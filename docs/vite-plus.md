# Calavera and Vite+

This page is for a reader who already knows Vite+ and wants to know what
Calavera adds on top of it, and what it deliberately leaves alone.

## The litmus test

Anywhere Calavera is fighting with or reimplementing something Vite or Vite+
already does well, Calavera steps aside, delegates to Vite+, and removes that
part of its own tooling. Removed means removed: no deprecated path, no
compatibility shim, no legacy profile. This is the same test css-console
applies to DevTools (`docs/evolution-brief.md` Section 3, C1; `AGENTS.md`).
Applied to the whole toolchain, the test resolves to one rule: Calavera
scaffolds no JavaScript or TypeScript linter, formatter, TypeScript
configuration, or test runner for any project, whether or not that project has
adopted Vite+ (ADR-0009, Decision).

## What Vite+ provides and what Calavera adds

Vite+ provides the toolchain (`vp --help` and `vp create --help`, vite-plus
1.0.0):

- `vp create`: create a new project from a template.
- `vp migrate`: migrate an existing project to Vite+.
- `vp lint`, `vp fmt` (`vp format`), `vp check`: lint, format, and run format,
  lint, and type checks.
- `vp test`: run tests.
- `vp build` and `vp pack`: build for production, or build a library.

Calavera adds, on top of that toolchain:

- The integration catalog's fourteen entries: EditorConfig, Stylelint,
  Stylelint standard config, CSS property ordering, CSS Baseline, SCSS support,
  Stylelint stylistic rules, Logical CSS, CSS property type validation, Knip,
  HTML Validate, Varlock, GitHub repository controls, and React Doctor
  (`packages/cli/src/catalog.js`).
- AI artifacts: skills, hooks, and subagents under `.agents/`, versioned as npm
  packages and tracked for updates (`docs/evolution-brief.md` Section 3, C3).
- MCP registration: a project-local server for Claude Code, Codex, Cursor, or
  OpenCode, so an agent composes and applies a recipe without leaving the
  editor (`docs/evolution-brief.md` Section 3, C3).
- GitHub repository governance: a desired-state policy, Dependabot
  configuration, and drift checks (`github-repository-controls` in
  `packages/cli/src/catalog.js`).
- The apply pipeline's safety properties and release verification
  (`docs/evolution-brief.md` Section 3, C3).
- The Baseline engine and the CSS verification lane, kept until Oxlint's CSS
  language plugin ships (`docs/evolution-brief.md` Section 3, C3).

## How Calavera knows a project is managed by Vite+

Calavera decides `vp`-managed status with one primary signal: whether
`vite-plus` appears as a key of `dependencies` or `devDependencies` in the
project's own `package.json` or in the nearest ancestor manifest that
declares it, walking upward to the filesystem root (ADR-0001, "The signal set
and its precedence"). That single walk is the ancestor rule: a workspace
member with no local declaration still reads as managed when its workspace
root declares the dependency, because the walk keeps climbing past the
member's own manifest.

Detection returns one of three statuses. `managed` means the primary signal
matched. `unmanaged` means the walk completed with no match. `unknown` means
the inspected directory has no readable `package.json` of its own, so no
ancestor result can promote it to `managed` or `unmanaged` (ADR-0001, "The
pure-function contract"). See ADR-0001 for the full contract, including the
corroborating signals that are recorded but never decide the verdict.

## Start a new project

`--new` is the one command that starts a project with both tools: it
confirms, spawns `vp create` through a package-manager runner with inherited
stdio, and continues into the `--init` bootstrap only when the child exits
zero and detection reports `managed` on the scaffolded directory (ADR-0010,
Decides). The npm form needs the `--` separator before Calavera flags, and the
pnpm, Yarn, and Bun launchers take `--new` directly, matching how they already
take `--init` (ADR-0010, Decision 5; `docs/agent-first-calavera-workflow.md`):

```bash
npm create project-calavera -- --new vite:library --no-interactive --package-manager pnpm
pnpm dlx create-project-calavera --new vite:library --no-interactive --package-manager pnpm
yarn dlx create-project-calavera --new vite:library --no-interactive --package-manager pnpm
bunx create-project-calavera --new vite:library --no-interactive --package-manager pnpm
```

Everything after `--new` forwards to `vp create` verbatim, including a `--`
that introduces template arguments; Calavera declares, validates, or renames
none of it (ADR-0010, Decision 5). The confirmation, shown before the spawn,
states the exact command line and working directory, that the runner may
download vite-plus, that Vite+ asks its own questions and Calavera does not
answer them, that dependency installation cannot be skipped, that Vite+ may
offer to clear a non-empty target directory, that Calavera's dry run does not
preview what Vite+ writes, and that `--init` runs automatically afterward
(ADR-0010, Decision 4). Vite+ owns every question it asks and every file it
writes; Calavera only orchestrates the hand-off (ADR-0010, Decides).

If you composed a recipe first, pass it with `--config` before `--new`:
`npm create project-calavera -- --config ~/Downloads/calavera.config.json --new`.
Calavera validates the recipe before `vp create` runs, copies it into the
scaffolded project as `calavera.config.json`, and prints the preview and apply
commands for it. It does not apply the recipe.

## Add Calavera to an existing Vite+ project

Scaffold with `vp create`, then bootstrap Calavera from the new project root
(`docs/agent-first-calavera-workflow.md`, "New Vite+ project"):

```bash
vp create
cd <created-project>
npm create project-calavera -- --init
```

For a project that predates Vite+, run `vp migrate` first. For a monorepo, run
it at the workspace root, not inside a single workspace member: "Migrate
monorepos from the workspace root so shared manifests, catalogs, overrides,
and lockfiles remain consistent" (<https://www.viteplus.dev/guide/migrate>),
because migration updates the package-manager configuration, catalogs, and
lockfiles that every member shares (ADR-0009, Decision).

## What the dry run tells you

`explain_recipe`, `compose_recipe`, and `dry_run_apply` carry a Vite+ report
built from the detection result (ADR-0011, Decision). On a managed project:

> Vite+ detection: managed. This project is vp-managed (vite-plus-dependency
> signal at package.json).
>
> JavaScript and TypeScript linting, formatting, type-checking, and testing
> are provided by Vite+, not by Calavera.

On an unmanaged project:

> Vite+ detection: unmanaged. No vite-plus dependency was found in this
> manifest or any ancestor manifest.
>
> Calavera provides no JavaScript or TypeScript toolchain; run vp create or vp
> migrate to adopt Vite+.

(ADR-0011, Decision; `packages/cli/src/index.js`, `vitePlusReport`.) When the
verdict is unmanaged but a corroborating signal, such as a leftover `vp`
script, is still present, a conflict line naming those signals sits between
the two lines above; when the verdict is unknown because `package.json` could
not be read, the report names the nearest ancestor manifest and its verdict
when one exists (ADR-0011, Decision).

## How apply installs development dependencies

In a project detection reports as managed, `apply` installs the recipe's
development dependencies with Vite+, by running `vp add -D <packages>`. Vite+
then runs the package manager and the version the project pins, for example
in `devEngines.packageManager`, which is the one `vp create` installed
`node_modules` with. Calavera does not choose a package manager there, so
`--package-manager` and the MCP `packageManager` input do not change the
install command (ADR-0012, Decision 1). A directory without a `package.json`
of its own inside a Vite+ workspace, such as a new workspace member, also
installs through Vite+, although detection reports it as unknown.

Calavera runs the `vp` bin of the vite-plus package the project itself
resolves, found the way Node.js finds any dependency: in the project's own
`node_modules`, then in each ancestor's, so a workspace member uses the
vite-plus installed at the workspace root. It starts that bin with the running
Node.js, so it does not need `vp` on `PATH` and never runs a globally
installed `vp` of another version (ADR-0012, Decision 2). Calavera decides the
install command and locates the bin before `apply` writes anything, including
a new `package.json`. If the project's vite-plus is not installed, or cannot
be used, `apply` stops at that point; install the project's dependencies, or
run `apply --no-install` and add the development dependencies yourself.

The dry run makes the same decision. `apply --dry-run` prints, for example,
`Dev dependency install command: vp add -D knip`, followed by the exact
command apply runs, or by the reason apply would stop. `dry_run_apply` and
`apply --dry-run --json` report these as `installCommand` and `installNotes`
(ADR-0012, Decision 3). A project detection reports as unmanaged, or as
unknown outside a Vite+ workspace, keeps its package manager's own command,
such as `pnpm add --save-dev knip`.

If the install fails, `apply` has already written the recipe's files,
`package.json` scripts, configuration, and `.calavera/state.json`. The error
lists what was written, gives the exact install command, which runs without
`vp` on `PATH`, says how it failed, and shows the last lines of its output. To
finish the install, run that command in the project directory (ADR-0012,
Decision 4).

In a directory without a `package.json` of its own, `apply` creates one with
the package manager's `init` command, and the dry run names that command. A
directory like this was not scaffolded by `vp create`, which always writes a
`package.json`, and `init` writes only that file, without linking
`node_modules`. The development dependency install that follows still goes
through `vp add -D` (ADR-0012, Decision 1).

## Profiles

Calavera offers two profiles. `default` composes `editorconfig`, `stylelint`,
`stylelint-standard`, and `stylelint-baseline`; `minimal` composes only
`editorconfig` (`packages/cli/src/recipe.js`, `profileDefaults`). Neither
carries a JavaScript or TypeScript toolchain component, so the same profile
applies whether or not the project is Vite+-managed (ADR-0011, Decision).

The `modern` and `classic` profiles were removed once their defaults became
identical to each other. A recipe naming either one fails validation with a
message naming the replacement, for example: "Invalid profile: modern. Allowed
values: default, minimal. The modern profile was removed; use default
instead." (ADR-0011, Decision; `packages/cli/src/recipe.js`,
`assertKnownProfile`.)

## Not yet

- [#433](https://github.com/schalkneethling/create-project-calavera/issues/433): regenerate the `vp` detection fixtures against a newer vite-plus release.
- [#431](https://github.com/schalkneethling/create-project-calavera/issues/431): `doctor` warns when a recipe still carries a JavaScript or TypeScript toolchain integration in a `vp`-managed project.
- [#430](https://github.com/schalkneethling/create-project-calavera/issues/430): offer create-here, apply-at-ancestor, or abandon when the inspected directory has no manifest of its own.
