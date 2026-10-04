# ADR-0013: The Generated `quality` Script Runs the Vite+ Checks

- **Status:** Accepted (2026-10-04, Schalk Neethling)
- **Date:** 2026-10-04
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/622
- **Decides:** what the generated `quality` script runs in a Vite+-managed project, and the rule for which `vp` commands a Calavera-written script may contain. In a project apply delegates to Vite+, `quality` runs `vp check` and the Vite+ test step before Calavera's own scripts. The Stylelint scripts are renamed from `lint` and `lint:fix` to `lint:styles` and `lint:styles:fix`, and a project applied before the rename is migrated. Detection and the C8 safety properties are unchanged.
- **Amends:** the "Vite+ And Delta Workflows" guidance in `docs/vite-plus-and-delta-mode.md`, which says generated scripts are never replaced with `vp` commands; the aggregate `quality` script is now the one exception.

## Context

Before this decision, `apply` wrote a `quality` script that ran only Calavera's own scripts, for example `pnpm lint && pnpm knip`, in every project. In a Vite+-managed project, that meant running `quality` checked the CSS, the HTML, and unused code, but not the JavaScript and TypeScript format, lint, and type checks, or the tests, that Vite+ provides. The developer had to remember a second command, and an agent that ran `quality` as the project's gate missed most of the checks.

The `vp-project-flow` test enforced a stricter rule than the brief states: no Calavera-written script may contain `vp` at all. Decision C2 of the evolution brief says that in a project where `vp` manages the toolchain, Calavera "does not write scripts that duplicate `vp` commands", and ADR-0001 quotes the same wording in its Context. A script that duplicates a `vp` command is one that stands in for it, such as a `lint` script that runs `vp lint`, or a `typecheck` script that runs `tsc`. An aggregate that calls `vp check` alongside Calavera's own scripts does not stand in for anything; it is the place where the project's gates meet.

The generated Stylelint script was named `lint`. In a Vite+-managed project, `lint` is the name a developer reaches for when they mean `vp lint`, so a Calavera `lint` that runs only Stylelint is misleading next to `vp lint`. The interface contract reserves `lint:css` for the task css-evolve declares, `css-evolve check`, and appends it to Calavera's `quality` script (`docs/cross-repo/interface-contract.md`, I4, "`vp run` tasks" and "Composite script"), so the Stylelint script cannot take that name.

The project owner chose this direction on issue #622 on 2026-10-04: option 1, with `lint` renamed, and `vp test --passWithNoTests` in `quality`, with the workspace-root test form verified during implementation. The owner first named the new script `lint:css`, then, once the clash with I4 surfaced, chose `lint:styles`.

## Evidence

The evidence comes from a vite-plus 1.0.0 global installation on the author's machine (`~/.vite-plus/1.0.0/node_modules/vite-plus`), read and run on 2026-10-04, and from scratch copies of the committed `vp create` fixtures in `packages/cli/fixtures/vite-plus/1.0.0/`, with `node_modules/vite-plus` linked to that installation. No network access was needed. vite-plus is not a dependency of this repository.

**`vp check`.** `vp check --help` prints `Usage: vp check [OPTIONS] [PATHS]...` and "Run format, lint, and type checks." Run with standard input closed and `CI=1` in a copy of the library fixture, it ran the checks once, printed `pass: All 6 files are correctly formatted`, reported a type error, and exited 1, with no prompt and no watch mode. The type error was `Cannot find type definition file for 'node'`, because the copy had no installed dependencies; the point here is that the command runs once and reports through its exit code. The library and monorepo-member fixtures already define `"check": "vp check"`, and the monorepo root's `ready` script starts with `vp check`.

**`vp test` runs once.** `vp test --help` prints "Run tests once by default. Options are forwarded to Vitest." and lists `--passWithNoTests` as "Pass when no tests are found". `docs/guide/test.md` in the package states: "Unlike Vitest on its own, `vp test` does not stay in watch mode by default."

**No test files.** In a copy of the library fixture, which has no test files because the fixture drops them, `vp test` printed `No test files found, exiting with code 1` and exited 1; `vp test --passWithNoTests` printed `No test files found, exiting with code 0` and exited 0. The real `vp create vite:library` output does contain `tests/index.test.ts` (`packages/cli/fixtures/vite-plus/1.0.0/README.md`, "Files dropped"), but a project whose tests were removed, or one created from another template, has none.

**`vp test` at a workspace root.** In a copy of the monorepo fixture with a test file restored at `packages/utils/tests/index.test.ts`, `vp test --reporter verbose` at the root reported `✓ packages/utils/tests/index.test.ts > member test runs`, with `RUN v5.0.1 <root>`. So `vp test` at the root finds member test files through Vitest's default `include`, `**/*.{test,spec}.?(c|m)[jt]s?(x)`, but it runs them from the root, with the root `vite.config.ts`. A member's own `vite.config.ts` `test` block and the member's own `test` script play no part. The root configuration in the fixture defines no `test.projects`.

**`vp run -r test`.** In the same copy, `vp run -r test` printed `~/packages/utils$ vp test` and ran the member's test with `RUN v5.0.1 <root>/packages/utils`, that is, in the member directory with the member's configuration. `apps/website`, which has no `test` script, was skipped. `vp run --help` describes `-r, --recursive` as "Select all packages in the workspace" and `[ADDITIONAL_ARGS]...` as "Additional arguments to pass to the task". With the test file removed, `vp run -r test` exited 1 (`No test files found, exiting with code 1`), and `vp run -r test --passWithNoTests` printed `~/packages/utils$ vp test --passWithNoTests` and exited 0, which shows that additional arguments are appended to every member's `test` script. With no package defining a `test` script, `vp run -r test` printed `Error: Task "test" not found` and exited 1. The template's own root `ready` script is `vp check && vp run -r test && vp run -r build`.

**Script ownership.** `.calavera/state.json` records managed files, not `package.json` scripts. The existing rule for scripts is value equality after an apply: `inspect_project` treats a script whose value already equals the one the recipe sets as Calavera's own once `.calavera/state.json` exists, and does not raise `existing-package-script` for it (#548). `removeDefaultTestScript` already deletes a script only when it holds an exact known value.

**Values earlier releases wrote.** Read from the history of `packages/cli/src/index.js` (`src/index.js` before 3120a66) at each release tag. Releases before 1.0.1 wrote no `.calavera/state.json`. Releases 1.0.1 to 2.0.6 built `lint` from the parts `oxlint .`, `eslint .`, and `stylelint "**/*.{css,scss}"`, in that order, joined with `&&`, each wrapped as `node .calavera/run-if-files.mjs "<label>" "<extensions>" -- <command>` with the label `JavaScript/TypeScript` and the extensions `js,jsx,ts,tsx,mjs,cjs` for Oxlint and ESLint, and `CSS` and `css,scss` for Stylelint; `lint:fix` used `oxlint --fix .`, `eslint --fix .`, and `stylelint "**/*.{css,scss}" --fix`. dd40dc3 stopped generating the helper, so 2.1.0 to 2.6.0 wrote the same parts bare. 48fb31e (CAL-012) removed Oxlint and d0a69be (CAL-015) removed ESLint, so 3.0.0 and later write Stylelint alone, which is the value planned today.

**Workspace definitions.** npm's `@npmcli/map-workspaces` (`getPatterns`) reads `workspaces` as an array or as an object whose `packages` is an array, and treats a pattern starting with an odd number of `!` as an exclusion. Yarn 1.22.22 (`yarn workspaces info`) and Bun 1.3.9 (`bun install`, recorded in `bun.lock`) each found the member `packages/a` with both forms. pnpm 10.33.2 printed `The "workspaces" field in package.json is not supported by pnpm. Create a "pnpm-workspace.yaml" file instead.` for a project with only that field. In the monorepo copy, with `test` removed from `packages/utils` and a root `test` script added, `vp run -r test` ran the root's script and exited 0, so the root counts as a package.

## Decision

### 1. The rule for `vp` in Calavera-written scripts

The rule changes from "no Calavera-written script contains `vp`" to "no Calavera-written script duplicates a `vp` command; the aggregate `quality` script may call `vp check` and the Vite+ test step". This is the rule brief C2 states. No other generated script calls `vp`, and no generated script calls a JavaScript or TypeScript toolchain binary directly. The `vp-project-flow` test enforces the new rule: every script Calavera writes must avoid the toolchain binaries, a script other than `quality` must not call `vp`, and `quality` may call `vp` only as `vp check`, `vp test --passWithNoTests`, or `vp run -r test`.

### 2. When `quality` runs the Vite+ checks

`quality` runs the Vite+ checks when apply delegates to Vite+, which is the same decision that makes apply install development dependencies with `vp add -D` (ADR-0012, Decision 1): ADR-0001 detection reports `managed`, or it reports `unknown` because the directory has no `package.json` of its own while the nearest ancestor verdict is `managed`, as in a new workspace member. The decision is made from one detection before apply writes anything, including a `package.json` it creates, so the dry run and the apply plan the same script. `delegatesToVitePlus` in `packages/cli/src/index.js` makes the choice for both the install and the script.

Every other project keeps a `quality` script without `vp`.

### 3. The shape of `quality`

In a project apply delegates to Vite+, `quality` is:

```text
vp check && <test step> && <run> lint:styles && <run> lint:html && <run> knip && <run> react:doctor && <run> env:load
```

`<run>` is the package manager's run command Calavera already uses, such as `pnpm lint:styles` or `npm run lint:styles`. Each Calavera script appears only when its integration is selected and its script is generated, in the order shown, as before this decision. `react:doctor` keeps its place, which the issue's examples did not list, because removing it from `quality` was not part of the decision. When no Calavera script is available to aggregate, `quality` is omitted with the existing reason, as before, rather than written as a script that only calls `vp`.

`vp test` runs with `--passWithNoTests`, because a project without test files otherwise fails `quality` with exit code 1, as the evidence shows, and a gate that fails a new project before any code is written is noise.

### 4. The test step at a workspace root

At a workspace root, the test step is `vp run -r test`. Which directories are workspace roots follows the package manager Calavera resolved for the project. For pnpm, a directory is a workspace root when its `pnpm-workspace.yaml` lists a non-empty `packages`; pnpm does not read the `package.json` field. For npm, Yarn, and Bun, it is a workspace root when its `package.json` lists a non-empty `workspaces`, as an array or as an object whose `packages` is an array. A `pnpm-workspace.yaml` that holds only catalogs, as `vp create vite:library` writes it, does not make a workspace root, and neither does an empty list. A missing or unparseable `pnpm-workspace.yaml` counts as absent, as missing files do in Vite+ detection. Every other directory, including a workspace member, uses `vp test --passWithNoTests`.

`vp test` at the root was not chosen. It finds the members' test files, but runs them with the root configuration, so a member that configures its tests in its own `vite.config.ts`, for example a DOM environment, would run them wrongly from `quality`. `vp run -r test` runs each member's own `test` script in the member's directory, which is what the template's `ready` script does.

`vp run -r test` is not given `--passWithNoTests`. Additional arguments go to every member's `test` script, whatever that script runs, so Calavera would be adding a Vitest option to scripts it did not write. A member whose `test` script is `vp test` and which has no test files fails `quality`; that is the member's own script, and the developer decides whether it passes with no tests.

`vp run -r test` fails with `Task "test" not found` when no package defines `test`, so apply checks before it writes the step. It reads the root's `package.json` and the `package.json` of each directory the workspace patterns name, as npm and pnpm do: a pattern names directories holding a `package.json`, a leading `./` or `/` is ignored, a pattern starting with an odd number of `!` excludes directories, and `node_modules` is never searched. Unlike npm, an exclusion applies whatever its position in the list. When neither the root nor any member defines `test`, `quality` leaves the step out rather than falling back to `vp test` at the root, for the reason above, and the `package.json` change in the dry run, `dry_run_apply`, and `apply --dry-run --json` reports it in its own field, `omittedQualitySteps`, as `[{ "step": "vp run -r test", "reason": "..." }]`, not in `omittedScripts`, because `quality` itself is written; the CLI prints it as `Would omit vp run -r test from script quality: ...`. The check is made from the files present before apply writes anything, so the dry run and the apply plan the same script.

### 5. The Stylelint scripts are `lint:styles` and `lint:styles:fix`

The generated Stylelint script is `lint:styles`. It is not `lint:css`, because the interface contract (I4) reserves `lint:css` for `css-evolve check` and appends it to `quality`; the project owner chose a name that does not collide, so css-evolve keeps `lint:css` as I4 states and both linters can sit in one `quality` script. The fix script is `lint:styles:fix`, so that the fix variant sits beside the script it fixes, under the same `lint:styles` prefix, as `lint:fix` sat beside `lint`. The recipe flags that request them keep their names, `lint` and `lint:fix`, because the recipe format is unchanged and an existing `calavera.config.json` keeps working; the schema descriptions now name the scripts the flags generate.

### 6. Projects applied before the rename

Apply treats a script under the old name as Calavera's only when both of these hold: `.calavera/state.json` exists, so Calavera applied to the project before, and the old script's value is exactly the value the recipe sets under the new name, or exactly one of the values an earlier release wrote for that name, listed under Evidence: any ordered selection of the Oxlint, ESLint, and Stylelint parts that includes the Stylelint part, bare or wrapped in run-if-files. A selection without Stylelint, such as `eslint .` or `oxlint . && eslint .`, is not renamed, although a release could have written it: a user's own script can hold the same value, and renaming it would replace it with Stylelint. Such a script is kept, as below. Apply then removes `lint` or `lint:fix` and writes `lint:styles` or `lint:styles:fix` with the value planned today, at the position the old name had in `scripts`. The `package.json` change in the dry run, `dry_run_apply`, and `apply --dry-run --json` carries `renamedScripts`, for example `[{ "from": "lint", "to": "lint:styles" }]`, and `apply --dry-run` prints `Would rename script lint to lint:styles`, so the rename is visible at the approval boundary.

When the new name already holds a different value, that script is the user's, and renaming would overwrite it. Apply then renames nothing, keeps both scripts as they are, and does not write the new name; the dry run lists the new name in `omittedScripts` and reports a `warning` finding of kind `legacy-package-script-conflict` that says what was not done, why, that the generated `quality` script runs the user's script under the new name until then, and how to complete the rename. The `existing-package-script` warning, which says apply replaces a script, is not raised for that name, because apply does not replace it.

When the old script holds any other value, it matches nothing Calavera wrote, so it is the user's. Apply keeps it and writes the new script beside it. `inspect_project`, and with it the dry run, reports the kept script with a `warning` finding of kind `legacy-package-script`, which names both scripts. For `lint`, the finding also says that the generated `quality` script now runs `lint:styles`, so the user's `lint`, which the old `quality` ran, no longer runs as part of it. It is a warning because the change to what `quality` runs is one the user may not expect. In a project Calavera never applied to, a `lint` script is the user's and is neither renamed nor reported.

This extends the existing ownership rule for scripts, value equality after an apply, to the old name. It does not add a record of scripts to `.calavera/state.json`.

### 7. What stays out of `quality`

Playwright and other test suites are not added to `quality`. The developer adds them to their own scripts; visual regression tests in particular should not run on every `quality`. `vp build` and `vp pack` are not added either.

## Consequences

Running `quality` in a Vite+-managed project now runs the format, lint, and type checks and the tests as well as Calavera's checks, so one command is the project's gate. A project that passed `quality` before may now fail it because `vp check` or the tests fail; that failure was always present and is now reported.

A project applied before this change has its `lint` and `lint:fix` scripts renamed on the next apply when their values are the ones Calavera wrote. Anything that runs `npm run lint` or `pnpm lint`, such as a CI workflow, must change to `lint:styles` or to `vp lint`, whichever it meant. The dry run shows the rename before it happens.

Because the generated `quality` script now contains `vp`, a project with that script also carries the `vp-scripts` corroborating signal ADR-0001 records. The signal never decides the verdict, and the script is written only in a project that is already managed or inside a managed workspace.

The C8 tests are unchanged and pass. Only the CLI writes into projects. `dry_run_apply` remains the approval boundary and shows the rename and any Vite+ step left out. A script the user changed is kept and reported, not overwritten, and a rename never overwrites the user's script under the new name. Nothing is recorded in `package.json` beyond scripts, as before. The existing `existing-package-script` warning, which says that apply replaces a script under a generated name whose value differs, now names `lint:styles` and `lint:styles:fix`.

`quality-script.test.mjs` covers the managed and unmanaged `quality`, each optional script present and absent, the workspace roots of pnpm, npm, Yarn, and Bun, a root whose own `test` is the only one, the test step left out when no package defines `test`, when the only one is excluded, and when the only one is under `node_modules`, the directories that are not workspace roots (a catalog-only, an empty, and an unparseable `pnpm-workspace.yaml`, workspaces the package manager does not read, and empty lists), a workspace member with a manifest, the omitted `quality` when nothing is aggregated, and the rename with the current value, a historical value, an edited value, a blocked rename, and a foreign `lint`, including the CLI dry run output and the kept position. `vp-project-flow.test.mjs` asserts the new rule, including `vpr` and `vite` duplicates, and the exact `quality` for the library, the monorepo root, and the monorepo member, and `dev-dependency-install.test.mjs` asserts it for a new member without a `package.json`.

## Alternatives considered

**Keep `quality` free of `vp`.** Rejected by the owner's decision. It leaves the project's main checks outside the gate Calavera generates, and the rule it rests on is stricter than brief C2.

**`vp test` at a workspace root.** Rejected; see Decision 4. It covers the members' test files but not their configuration.

**`vp test` at the root when no package defines `test`.** Rejected by the owner. It would run the members' test files with the root configuration, the problem Decision 4 avoids, and it hides that the workspace has no `test` script to run.

**`vp run -r test --passWithNoTests` at a workspace root.** Rejected; see Decision 4. It passes a Vitest option to scripts Calavera did not write.

**Write `quality` as only `vp check && vp test --passWithNoTests` when no Calavera script is selected.** Rejected. Such a script only repeats Vite+ commands, which is what C2 forbids, and the `minimal` profile's output would change for no gain.

**Record generated scripts in `.calavera/state.json`.** Not chosen. It would let apply recognize a script it wrote even after a recipe change, but it changes the state format, and value equality, which apply already uses for scripts, is enough to make the rename safe: a mismatch only ever keeps a script, never removes one.

**Rename the recipe flags to `lint:styles` and `lint:styles:fix`.** Not chosen. It would invalidate every existing `calavera.config.json` and the published schema for a naming gain only, and recipe validation would need a migration message like the removed profiles have.
