# create-project-calavera

## 4.0.2

### Patch Changes

- cc7ba77: In a project Vite+ manages, `apply` and `apply_recipe` now install the recipe's development dependencies with `vp add -D <packages>`, run through the project's own vite-plus with the running Node.js, so Vite+ uses the package manager and version the project pins, for example in `devEngines.packageManager`, and `vp` does not have to be on `PATH`. Previously, apply ran the package manager on `PATH`, which failed in projects created with `--new` whenever that version differed from the one `vp create` pinned, for example with `ERR_PNPM_UNEXPECTED_STORE`. A directory without a `package.json` of its own inside a Vite+ workspace installs through Vite+ too. There, `--package-manager` and the MCP `packageManager` input no longer change the install command. Projects Vite+ does not manage keep their package manager's command. Apply decides the install command before it writes anything, and the dry run makes the same decision: `apply --dry-run` prints the command and the exact command line apply runs, and `apply --dry-run --json` and `dry_run_apply` report them in the new `installCommand` and `installNotes` result fields. When the project's vite-plus is not installed or cannot be used, the dry run says so, and apply stops before writing anything with an error that names the reason and suggests installing the project's dependencies or using `--no-install`. When the install fails, the CLI no longer hangs with the spinner running: it stops the spinner, exits with a non-zero code, and prints an error that lists the files apply already wrote, gives the exact install command to run to finish, says how it failed, and shows the last lines of its output. A failed `package.json` creation stops its spinner and exits the same way.

## 4.0.1

### Patch Changes

- 8630b38: `apply`, `apply --dry-run`, `dry_run_apply`, and `apply_recipe` no longer fail with "Artifact … is not locked" when the recipe selects an AI artifact that `.calavera/artifacts.lock.json` does not list, which made every first apply of a recipe with artifacts fail. Apply now installs those artifacts first, as `artifacts install` would. A dry run stages the install in temporary storage, writes nothing to the project, and reports each artifact it would resolve and lock, with its version, in the new `autoInstalledArtifacts` result field and in the CLI output. `apply` and `apply_recipe` lock and install only the artifacts without a lock entry, in one artifact transaction, and then apply the rest of the recipe against the new lock. Artifacts that are already locked keep their exact locked versions; only `artifacts update` advances a version. Before the install commits, apply checks every selected artifact, locked or not, against the project. If an artifact output would overwrite a local edit or a file Calavera does not manage, or the install fails for any other reason, apply stops with an error that names `artifacts install` and includes the underlying cause. When the install stops before its transaction commits, or a partly committed transaction rolls back, the artifact lock, artifact outputs, and Calavera state are left as they were. If the rollback itself fails, the error reports both failures, the project may be partly changed, and the next `apply`, `apply_recipe`, or `artifacts` command retries the rollback; a dry run refuses to run until it has. Registry cache entries can remain in an existing `.calavera/cache/npm`. Installing artifacts adds no dependencies to `package.json` and writes nothing to `node_modules`.

## 4.0.0

### Major Changes

- 0e0d97e: Collapse the `modern` and `classic` profiles, whose defaults became identical after the JavaScript and TypeScript toolchain removals, into one profile with the id `default`; `minimal` is unchanged. A `calavera.config.json`, `--profile` flag, or MCP call that names `modern` or `classic` now fails validation with a message naming `default` as the replacement: change the value to `default`, and the recipe produces the same files, scripts, and dependencies as before. `explain_recipe`, `compose_recipe`, `dry_run_apply`, and `apply --dry-run` now report the Vite+ detection result (`managed`, `unmanaged`, `unknown`, or a signal conflict), and for a `vp`-managed project state that JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera. See [ADR-0011](../docs/adr/0011-collapse-profiles-to-minimal-and-default.md).

### Minor Changes

- 00e2cd8: Every entry in the integration catalog now carries a `summary` (a one-sentence, plain-language description under 140 characters) and a `homepage` (an `https:` URL to the tool's own site or repository). `list_integrations` and `describe_integration` return both fields, and the generated `description` is now prefixed with the summary. `github-repository-controls`, which has no upstream tool, links to the Calavera documentation that describes it.
- 5a1b3a0: After a recipe is applied, `dry_run_apply` and `apply --dry-run` report a managed file, `calavera.config.json`, or `package.json` script update whose result already matches the project with the new change type `unchanged`, and the CLI dry run ends with "Nothing to change" when every change is unchanged. `inspect_project` no longer raises `existing-config` for a file whose contents match its hash in `.calavera/state.json`, nor, once the recipe was applied, `existing-package-script` for a script that already has the value the recipe sets. `apply` skips rewriting unchanged files. A managed file with local edits still yields `managed-file-conflict`.
- de94a66: `--new` accepts a recipe: pass `--config <path>` before `--new` to hand a recipe you composed, for example on the hosted Composer, to the project Vite+ scaffolds. Calavera reads the file and validates it before it starts `vp create`, and refuses a missing file or an invalid recipe with nothing run or written. After `vp create` exits with code 0 and Vite+ detection reports the scaffold as managed, Calavera copies the file byte for byte to `calavera.config.json` in the scaffolded directory, runs the bootstrap, and prints the preview and apply commands for that recipe. Calavera never applies it; `dry_run_apply` stays the approval boundary. A canceled, failed, or unmanaged scaffold copies nothing, an existing `calavera.config.json` in the scaffolded directory is not replaced, and `--dry-run` names the planned copy.
- 9e726b7: Add `--new`: Calavera scaffolds a project that does not exist yet by running `vp create` through the package-manager runner (`npx`, `pnpm dlx`, `yarn dlx`, or `bunx`, from `--package-manager`) with inherited stdio, so Vite+ asks its own questions, and every token after `--new` goes to `vp create` unchanged. Calavera confirms first, showing the exact command and directory; `--yes` skips the prompt, `--dry-run` prints the command and runs nothing (both must come before `--new`, as everything after it belongs to `vp create`), and a non-interactive session without `--yes` is refused. When `vp create` exits zero and Vite+ detection reports the scaffolded directory as managed, the `--init` bootstrap runs there. Otherwise, and when `vp create` exits with a code or signal, is canceled, leaves no new or changed `package.json`, or leaves more than one candidate, Calavera stops with a message naming the reason, writes nothing further, removes nothing, and does not run the bootstrap. `--new` is refused when a `package.json` already exists in the current directory (run `--init` there instead), and cannot be combined with `--init` or `--json`. Requires Node.js 22.18, 24.11, or 26 and newer, the Vite+ 1.0.0 floor. See [ADR-0010](../docs/adr/0010-new-delegates-scaffolding-to-vp-create.md).
- 9877837: After a successful `--new`, and after `--init`, the CLI prints the next steps: the project needs a recipe before Calavera changes anything, so the block names both ways to get one, the agent prompt printed above it or the hosted Composer at https://calavera.schalkneethling.com/, with the directory to save `calavera.config.json` into and the preview and apply commands for the project's package manager. After `--new` the commands start with a `cd` into the scaffolded directory; `--init` omits it. When the project already has `calavera.config.json`, the block names that file instead. `--init --json` returns the same lines as a `nextSteps` array and the resolved `packageManager`. The `--new` dry run and every `--new` stop print no block.
- 0885b1c: `github-repository-controls` now applies only at the repository root, because GitHub reads `.github/` only there. When a recipe selects it and the project directory is not the repository root (the nearest ancestor with a `.git` entry), `apply`, `apply --dry-run`, `dry_run_apply`, and `apply_recipe` stop with a hard stop before any file is planned or written. The message names the project directory, the repository root, and the command to run there, with `--config <path>` when the recipe is saved in the member; apply a recipe that selects the integration at the repository root, or remove `github-repository-controls` from the member's recipe. A project that is not yet a git repository counts as its own root. `list_integrations`, `describe_integration`, and `explain_recipe` now say the integration applies at the repository root.

### Patch Changes

- Updated dependencies [1aaac09]
  - @schalkneethling/calavera-baseline-core@0.2.2

## 3.0.0

### Major Changes

- 3679738: Remove the Oxlint integration and its fourteen plugin pack entries (`oxlint`, `oxlint-eslint`, `oxlint-typescript`, `oxlint-unicorn`, `oxlint-oxc`, `oxlint-import`, `oxlint-react`, `oxlint-jsx-a11y`, `oxlint-node`, `oxlint-promise`, `oxlint-vitest`, `oxlint-jest`, `oxlint-nextjs`, `oxlint-vue`, `oxlint-jsdoc`). Calavera no longer writes `oxlint.json` or adds `oxlint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp lint`. The Calavera skill no longer lists `oxlint.json` among the files to inspect. See [ADR-0002](../docs/adr/0002-remove-oxlint.md) and the catalog audit for the evidence.
- 12d4226: Remove the Oxfmt integration (`oxfmt`). Calavera no longer adds `format` and `format:check` scripts that run Oxfmt and no longer rejects a recipe for selecting both Oxfmt and Prettier, since only Prettier remains until its own removal; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names `oxfmt` now fails validation as an unknown id: on a Vite+ project, remove the id and rely on `vp fmt` and `vp check`; a project that has not adopted Vite+ and uses the Classic profile keeps Prettier until CAL-016 removes it. Once CAL-016 lands, Calavera provides no formatter to any project, and a project without Vite+ runs `vp create` or `vp migrate` first. The Calavera skill no longer describes Oxfmt as an option. See [ADR-0003](../docs/adr/0003-remove-oxfmt.md) and the catalog audit for the evidence.
- 4ae0d07: Remove the TypeScript configuration integration (`typescript`). Calavera no longer writes `tsconfig.json`, no longer installs `typescript` and `@types/node` for that entry, and no longer adds a `typecheck` script; the recipe's `scripts.typecheck` option is removed from the configuration schema because it had no other subject. On a Vite+ project, `vp create` writes `tsconfig.json` and `vp check` type-checks through tsgolint. A `calavera.config.json` that names `typescript` now fails validation as an unknown id; one that still sets `scripts.typecheck` validates but the flag is ignored and no `typecheck` script is generated. Remove both and rely on `vp check`. Entries that depend on the TypeScript package, such as `typescript-eslint` until its own removal, keep installing it themselves. The Calavera skill no longer lists `tsconfig.json` among the files to inspect. See [ADR-0004](../docs/adr/0004-remove-typescript-configuration.md) and the catalog audit for the evidence.
- aa1545c: Remove the JavaScript and TypeScript ESLint flat config integration (`eslint`) and the eleven entries that include it (`typescript-eslint`, `eslint-config-prettier`, `eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`). Calavera no longer writes `eslint.config.js` or adds `eslint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. Nine of the removed plugin entries (`eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`) installed a dependency but never entered the generated configuration; projects that selected them can remove that dependency. A `calavera.config.json` that names any removed id now fails validation as an unknown id. This removal is the JavaScript ESLint host only; the CSS lint host css-evolve needs (`@eslint/css`) is unaffected. See [ADR-0005](../docs/adr/0005-remove-eslint-flat-config.md) and the catalog audit for the evidence.
- 4264b1c: Remove the Prettier integration (`prettier`) and the entries that include it (`prettier-tailwind`, `prettier-svelte`, `prettier-astro`). Calavera no longer writes `.prettierrc.json` or `.prettierignore` and no longer adds `format` or `format:check` scripts for any project; the recipe's `scripts.format` and `scripts.format:check` options are removed from the configuration schema because no integration can satisfy them, and a recipe that still sets them validates but produces no script; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp fmt`. With this change the Modern and Classic profiles have identical defaults; their collapse is decided separately. See [ADR-0006](../docs/adr/0006-remove-prettier.md) and the catalog audit for the evidence.

## 2.6.0

### Minor Changes

- 3cb9785: `inspect_project` now reports whether the project is managed by Vite+ through an optional `vitePlus` field and four new finding kinds (`vite-plus-managed`, `vite-plus-unmanaged`, `vite-plus-signal-conflict`, `vite-plus-detection-unknown`). The change is additive, with nothing changed or removed; see [ADR-0001](../docs/adr/0001-vite-plus-detection-signal.md) for the detection signal and its rationale.

## 2.5.0

### Minor Changes

- 499016c: Add an optional GitHub repository-controls integration that generates managed desired-state,
  Dependabot, audit/apply script, and documentation files without mutating GitHub during Calavera
  apply.
- dc6be3d: Extend GitHub repository controls with CodeQL merge protection and default newly generated policies to the extended query suite. Verify branch scope and bypass protections, preserve unrelated rules and scanners during updates, and retain read-only checks and explicit apply with read-back verification.

### Patch Changes

- 9386307: Isolate independently versioned skills, hooks, and agents from the CLI runtime dependency graph while preserving explicit locked artifact installation and updates.
- ad107fd: Apply upstream review corrections to frontend, publishing, and agent artifacts, and exclude installed Calavera package and Claude agent payloads from downstream CodeRabbit reviews.
- Updated dependencies [9386307]
  - @schalkneethling/calavera-artifact-core@0.4.0

## 2.4.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [d65cb63]
- Updated dependencies [5d620bc]
  - @schalkneethling/calavera-artifact-core@0.3.0

## 2.4.0-next.1

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [5d620bc]
  - @schalkneethling/calavera-artifact-core@0.3.0-next.1

## 2.4.0-next.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- Updated dependencies [d65cb63]
  - @schalkneethling/calavera-artifact-core@0.3.0-next.0

## 2.3.0

### Minor Changes

- c0ad502: Add merge-safe CodeRabbit path exclusions whenever Calavera installs skill artifacts.
- e5151e0: Add optional Knip unused-code analysis with managed configuration and quality script integration.
- dcdade0: Add the shared Baseline recommendation engine and carry configurable Stylelint Baseline targets through recipes, generated configuration, CLI, and MCP tools.
- cae2686: Add optional HTML validation with managed HTML Validate configuration, ignores, scripts, and cross-surface catalog support.
- Add the Varlock environment schema and validation integration, contributed by Theo Ephraim in #127.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- 9dff8ff: Report planned deletions and locally edited skips in human-readable clean output.
- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- 4a4e91c: Expose minimum CLI versions for integrations so the hosted Composer can avoid unreleased CLI capabilities.
- Updated dependencies [76d85ef]
- Updated dependencies [e3e46a7]
- Updated dependencies [d525776]
- Updated dependencies [32b3315]
- Updated dependencies [71d46d1]
- Updated dependencies [dcdade0]
- Updated dependencies [dd70f1e]
- Updated dependencies [6ae1222]
  - @schalkneethling/calavera-baseline-core@0.2.0
  - @schalkneethling/calavera-artifact-core@0.2.0

## 2.3.0-next.3

### Patch Changes

- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- Updated dependencies [e3e46a7]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.3
  - @schalkneethling/calavera-artifact-core@0.2.0-next.3

## 2.3.0-next.2

### Patch Changes

- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- Updated dependencies [71d46d1]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.2
  - @schalkneethling/calavera-artifact-core@0.2.0-next.2

## 2.3.0-next.1

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- Updated dependencies [76d85ef]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.1
  - @schalkneethling/calavera-artifact-core@0.2.0-next.1

## 2.3.0-next.0

### Minor Changes

- c0ad502: Add merge-safe CodeRabbit path exclusions whenever Calavera installs skill artifacts.
- e5151e0: Add optional Knip unused-code analysis with managed configuration and quality script integration.
- dcdade0: Add the shared Baseline recommendation engine and carry configurable Stylelint Baseline targets through recipes, generated configuration, CLI, and MCP tools.
- cae2686: Add optional HTML validation with managed HTML Validate configuration, ignores, scripts, and cross-surface catalog support.
- Add the Varlock environment schema and validation integration, contributed by Theo Ephraim in #127.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- 9dff8ff: Report planned deletions and locally edited skips in human-readable clean output.
- 4a4e91c: Expose minimum CLI versions for integrations so the hosted Composer can avoid unreleased CLI capabilities.
- Updated dependencies [d525776]
- Updated dependencies [32b3315]
- Updated dependencies [dcdade0]
- Updated dependencies [dd70f1e]
- Updated dependencies [6ae1222]
  - @schalkneethling/calavera-baseline-core@0.2.0-next.0
  - @schalkneethling/calavera-artifact-core@0.2.0-next.0
