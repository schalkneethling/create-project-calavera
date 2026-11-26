# @schalkneethling/calavera-skill-calavera

## 0.2.6

### Patch Changes

- a998558: When Calavera cannot remove one of its temporary folders after apply has written the AI outputs, apply now finishes instead of stopping before the config, the `package.json` scripts, and the state are written. The summary names each folder left behind under Notes with the error code and asks you to remove it. The `--json` result and the MCP `dry_run_apply` and `apply_recipe` tools carry the folders in the new `temporaryFolderLeftovers` field, and the dry run reports the same failure the same way. Apply still exits non-zero when a later step fails, such as a file write or the dependency install, and that error names the folders too. A folder inside the project, such as one under `.calavera/.transactions/`, is reported with a note to remove it before you commit if Git does not ignore it. Messages about a failed removal now name the temporary folder and the error code instead of repeating the underlying error's message. The base Calavera skill now asks agents to show each entry in `temporaryFolderLeftovers` as a warning with its remedy, after the dry run and after apply (#1033).
- 65a9577: Apply now removes a `.calavera/.staging/<id>` folder that 6.2.1 or an earlier release left after restoring a locked artifact package, but only when the folder holds exactly the package the lock records for `<id>`. Apply rebuilds that package from the artifact cache to compare them. Every other entry in `.calavera/.staging/`, such as an edited folder, a folder no lock entry names, or a symbolic link, is kept and reported with the reason. `apply --dry-run` and `apply` list each entry under Files, and the `--json` result and the MCP `dry_run_apply` and `apply_recipe` tools carry it in the new `stagingLeftovers` field. Apply checks each folder again just before it removes it. A folder it cannot read or remove is reported without stopping apply. The base Calavera skill now asks agents to show `stagingLeftovers` with the rest of the dry run (#1034).
- 5d35e33: The Calavera skill no longer lists a fixed set of MCP tools to look for. It now tells the agent to use only the Calavera tools that the MCP server lists, because the skill and the project's pinned server update separately, and a skill newer than the server may describe a tool that the server does not have. The skill also separates two cases that it used to treat the same. When no Calavera tools are listed to the agent, the agent tells the user that the tools are unavailable, names both causes (the server is not registered, or the client does not allow the tools), and asks before registering or repairing anything. When the server lists Calavera tools but not one a step names, the agent tells the user which tool is missing and continues with the tools it lists; when that tool is `compose_recipe`, `dry_run_apply`, or `apply_recipe`, it applies nothing through MCP.

  Before switching from the MCP tools to the CLI fallback, for any reason, the agent now asks the user and waits for agreement. When the user refuses a Calavera tool call at a permission prompt, the agent stops and asks, and never runs the CLI apply command in its place unless the user then agrees to switch. When asking to switch because a tool is not listed, the agent names both possible causes: the pinned server version lacks the tool, or the user's own permission rules hide it. In the fallback, a recipe already composed through MCP is saved outside the project and passed to `apply --config <path> --dry-run`, so the user does not compose it again and the agent does not write `calavera.config.json` itself. The prompt the skill suggests no longer tells the agent to stop when a single tool is missing. The copy that `--init` installs changes the same way (#1053).

- 013b0f2: Every description of `--reown-managed-file` now says that `apply` replaces the edited file's current contents with Calavera's, so the edits are lost unless you save a copy first. Before, the dry run's warning said the run would "treat the current contents as an approved managed-file baseline", which read as keeping the edit. The change covers the dry run's `managed-file-reown` warning, the `--help` text, the MCP `reownManagedFiles` input description, and both copies of the Calavera skill, which now also tell the agent never to use `reownManagedFiles` to keep an edit. What the flag does is unchanged (#1167).
- 4eed3a0: The new `eject` command stops Calavera managing a project and keeps every tool it installed (#678, ADR-0017). It removes the state, the recipe, the artifact lock and package copies, the artifact cache and its `.gitignore` block, the bootstrap guidance, the MCP setup notes and the `calavera` MCP entry, a `.coderabbit.yaml` that Calavera created, and the base Calavera skill. `eject --dry-run` lists every deletion and edit, with the exact text each edit removes and the text the file holds afterward, and changes nothing. For an MCP harness file it shows only the lines around Calavera's entry, with values hidden, and `--json` leaves that file's text out, so other servers' tokens stay out of logs (ADR-0017, Amendment 3); it refuses while an artifact transaction is pending, which `eject` without `--dry-run` recovers first. An interactive `eject` shows the same list, marks each item as edited, unedited, or "edits cannot be detected", and removes nothing until the person approves the whole list. Without a terminal, or with `--json`, `eject` refuses unless `--yes` is given, and `--yes` removes only the items that match Calavera's records exactly and lists what it left. `eject` never writes `package.json`: it reports each script that runs Calavera and the `create-project-calavera` development dependency, with the command that removes it for the project's package manager, or `vp remove` under Vite+. It also reports footprint text it keeps, and a footprint elsewhere in the workspace. `--json` prints a structured result. The Calavera skill, and the copy `--init` installs, now tell the agent that `eject` is a CLI command the user runs in their own terminal, not an MCP tool. `clean`'s summary now starts a skip reason with "This item", capitalized, when the reason starts with the item's own path.
- 6e232db: The Calavera skill now tells the agent to look for all 14 MCP tools the server registers, including `describe_integration` and the four Baseline tools, `list_baseline_targets`, `describe_baseline_target`, `search_baseline_features`, and `recommend_baseline_target`. The copy that `--init` installs changes the same way, and a test fails when either copy or the README's tool-order list differs from the registered tools (#933).
- 52c007f: The Calavera skill now tells the agent what to do when `dry_run_apply` returns `manifestDecision`: show the user the ancestor manifest and the three choices, `create-here`, `apply-at-ancestor`, and `abandon`, never pick one, and pass the user's choice as `manifestChoice` to `dry_run_apply` and then `apply_recipe`. The copy that `--init` installs changes the same way, and a test fails when either copy stops naming the result, the input, or a choice the CLI offers (#962).
- c7507ee: The Calavera skill now tells the agent when to use the four Baseline tools: when the recipe selects `stylelint-baseline`, ask the user for a Baseline target, show the targets from `list_baseline_targets` or `describe_baseline_target`, turn the CSS features the user needs into a target with `search_baseline_features` and `recommend_baseline_target`, and record a target other than the default `widely` in `integrationOptions.stylelint-baseline.available`. The copy that `--init` installs changes the same way, and a test fails when either copy stops naming a Baseline tool in that guidance (#965).

## 0.2.5

### Patch Changes

- 085b4a3: The Calavera skill now tells the agent to confirm each entry in `compose_recipe`'s `integrationInputs`, such as `github-repository-controls.defaultBranch`, with the user before `dry_run_apply`, and to show where each default came from. It also tells the agent to show the dry run's `integrationInputs` and `inputWarnings`, and that `apply_recipe` refuses an integration input the recipe does not record (#846, #844).
- 87de60b: A catalog integration can now declare the lines it needs in a project's `.gitignore` and in the managed `.htmlvalidateignore`, in an `ignore` field of its catalog entry (ADR-0016). Apply writes an integration's `.gitignore` lines as a block between `# calavera:<id>:start` and `# calavera:<id>:end`, after your own lines, which stay exactly as they were and in the same order. Apply records the block in `.calavera/state.json` as `gitignoreBlocks`, replaces it only while it still holds what apply wrote, and removes it when the recipe no longer selects the integration. If you edited the block, the dry run and apply stop with a conflict that shows both texts, and nothing is written.

  The dry run lists the lines each integration adds to or removes from both files, and `apply --json` and `dry_run_apply` return them as `ignoreChanges`. After apply, a second dry run reports both files as unchanged.

  The html-validate integration now declares its own `.htmlvalidateignore` lines this way, so a recipe with html-validate writes the same file as before. No integration in this release declares `.gitignore` lines yet, and Varlock keeps its existing `.gitignore` merge.

  The Calavera skill now tells the agent to show `ignoreChanges` to the user as part of the dry run.

- c4a5bde: The Calavera skill now tells the agent to confirm the test runner with the user when the recipe selects `stryker`, to offer the runners that `list_integrations` and `describe_integration` list in `testRunners`, and to record the choice in `integrationOptions.stryker.testRunner`, with `testFiles` for `node:test` only when the project's test paths differ from the `node --test` defaults (#890).

## 0.2.4

### Patch Changes

- 873e517: Add `skill-protected-branch-guard`, which refuses a commit, a push, or a Claude Code file edit on the branch you protect (ADR-0015). Apply installs the skill and wires it into the project: a marked block in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and hook groups in the committed `.claude/settings.json`. The dry run shows every line and group first, and apply stops with a conflict, writing nothing, when you have edited its part.

  Calavera asks for the protected branch, with the current branch as the default, and records it in the recipe. `compose_recipe` reports the input and its default, `dry_run_apply` returns the recipe with the value filled in, and `apply_recipe` refuses a recipe that does not record it, so the branch cannot change between approval and apply. When Git would not run the hooks, because the Vite+ hook dispatcher is not installed or hooks are turned off in the clone, apply warns and names the command that fixes it.

  A rewritten `.claude/settings.json` is formatted before the dry run with the project's own `vp fmt`, so it already passes `vp check` with the project's formatter settings.

## 0.2.3

### Patch Changes

- f893fbe: The Calavera skill asks the agent to show the user the command each `package.json` script in the `dry_run_apply` result's `scriptChanges` will run, and for a changed or renamed script the command it replaces, before asking for approval.

## 0.2.2

### Patch Changes

- fba4a61: Drop the upper bound from the Calavera compatibility range so the artifact installs on create-project-calavera 3.0.0 and later. Every artifact declared `<3`, and the 3.0.0 CLI rejected all of them at install time while the hosted Composer hid them as waiting for a newer CLI. The lower bound stays: it is what keeps Composer from offering an artifact before a CLI that can install it is published. A change to the manifest contract itself is signaled by `schemaVersion`, not by a CLI major. The artifact catalog in `@schalkneethling/calavera-artifact-core` carries the same ranges and changes with them.

## 0.2.1

### Patch Changes

- 3679738: Remove the Oxlint integration and its fourteen plugin pack entries (`oxlint`, `oxlint-eslint`, `oxlint-typescript`, `oxlint-unicorn`, `oxlint-oxc`, `oxlint-import`, `oxlint-react`, `oxlint-jsx-a11y`, `oxlint-node`, `oxlint-promise`, `oxlint-vitest`, `oxlint-jest`, `oxlint-nextjs`, `oxlint-vue`, `oxlint-jsdoc`). Calavera no longer writes `oxlint.json` or adds `oxlint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp lint`. The Calavera skill no longer lists `oxlint.json` among the files to inspect. See [ADR-0002](../docs/adr/0002-remove-oxlint.md) and the catalog audit for the evidence.
- 12d4226: Remove the Oxfmt integration (`oxfmt`). Calavera no longer adds `format` and `format:check` scripts that run Oxfmt and no longer rejects a recipe for selecting both Oxfmt and Prettier, since only Prettier remains until its own removal; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names `oxfmt` now fails validation as an unknown id: on a Vite+ project, remove the id and rely on `vp fmt` and `vp check`; a project that has not adopted Vite+ and uses the Classic profile keeps Prettier until CAL-016 removes it. Once CAL-016 lands, Calavera provides no formatter to any project, and a project without Vite+ runs `vp create` or `vp migrate` first. The Calavera skill no longer describes Oxfmt as an option. See [ADR-0003](../docs/adr/0003-remove-oxfmt.md) and the catalog audit for the evidence.
- 4ae0d07: Remove the TypeScript configuration integration (`typescript`). Calavera no longer writes `tsconfig.json`, no longer installs `typescript` and `@types/node` for that entry, and no longer adds a `typecheck` script; the recipe's `scripts.typecheck` option is removed from the configuration schema because it had no other subject. On a Vite+ project, `vp create` writes `tsconfig.json` and `vp check` type-checks through tsgolint. A `calavera.config.json` that names `typescript` now fails validation as an unknown id; one that still sets `scripts.typecheck` validates but the flag is ignored and no `typecheck` script is generated. Remove both and rely on `vp check`. Entries that depend on the TypeScript package, such as `typescript-eslint` until its own removal, keep installing it themselves. The Calavera skill no longer lists `tsconfig.json` among the files to inspect. See [ADR-0004](../docs/adr/0004-remove-typescript-configuration.md) and the catalog audit for the evidence.
- aa1545c: Remove the JavaScript and TypeScript ESLint flat config integration (`eslint`) and the eleven entries that include it (`typescript-eslint`, `eslint-config-prettier`, `eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`). Calavera no longer writes `eslint.config.js` or adds `eslint` to the `lint` and `lint:fix` scripts; on a Vite+ project, `vp lint` and `vp check` provide JavaScript and TypeScript linting. Nine of the removed plugin entries (`eslint-react`, `eslint-jsx-a11y`, `eslint-import`, `eslint-n`, `eslint-promise`, `eslint-unicorn`, `eslint-sonarjs`, `eslint-vitest`, `eslint-jest`) installed a dependency but never entered the generated configuration; projects that selected them can remove that dependency. A `calavera.config.json` that names any removed id now fails validation as an unknown id. This removal is the JavaScript ESLint host only; the CSS lint host css-evolve needs (`@eslint/css`) is unaffected. See [ADR-0005](../docs/adr/0005-remove-eslint-flat-config.md) and the catalog audit for the evidence.
- 4264b1c: Remove the Prettier integration (`prettier`) and the entries that include it (`prettier-tailwind`, `prettier-svelte`, `prettier-astro`). Calavera no longer writes `.prettierrc.json` or `.prettierignore` and no longer adds `format` or `format:check` scripts for any project; the recipe's `scripts.format` and `scripts.format:check` options are removed from the configuration schema because no integration can satisfy them, and a recipe that still sets them validates but produces no script; on a Vite+ project, `vp fmt` and `vp check` provide formatting. A `calavera.config.json` that names any removed id now fails validation as an unknown id: remove the ids and rely on `vp fmt`. With this change the Modern and Classic profiles have identical defaults; their collapse is decided separately. See [ADR-0006](../docs/adr/0006-remove-prettier.md) and the catalog audit for the evidence.

## 0.2.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.

## 0.2.0-next.3

### Patch Changes

- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.

## 0.2.0-next.2

### Patch Changes

- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.

## 0.2.0-next.1

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.

## 0.2.0-next.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.
