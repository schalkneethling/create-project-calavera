# Draft: Contributing a Calavera Integration, From Catalog Entry to Post-Install Pointers

Calavera works best when a new tool integration starts in the catalog. Metadata
should describe the integration first; integration-specific behavior should be
added only when the tool needs scripts, files, diagnostics, or follow-up guidance
that metadata cannot express. Theo Ephraim's Varlock contribution in
[PR #127](https://github.com/schalkneethling/create-project-calavera/pull/127)
is a good walkthrough because it touches the whole contribution path:
catalog metadata, dependencies, scripts, `apply`, `doctor`, the web composer,
and tests.

Thank you to [Theo Ephraim](https://github.com/theoephraim) for contributing the
Varlock integration example.

## Start With the Catalog

Calavera is catalog-first. The shared integration catalog is the source of truth
for the CLI and should describe the new integration before custom behavior is
added elsewhere.

For Varlock, the catalog entry introduced a small optional integration:

```js
{
  id: "varlock",
  label: "Varlock",
  group: "Environment variables",
  platform: "varlock",
  status: "optional",
  dependencies: ["varlock"],
}
```

That one entry establishes the contract Calavera needs:

- `id`: the stable recipe value project developers add to
  `calavera.config.json`.
- `label`: the human-readable name shown in prompts and the composer.
- `group`: where the integration belongs in the catalog.
- `platform`: the tool family custom generation code can key off.
- `status`: whether the integration is recommended, optional, experimental, or
  framework-specific.
- `dependencies`: the development packages Calavera installs when the recipe
  selects the integration.

Start in [`src/catalog.js`](../src/catalog.js). Then decide whether metadata is
enough or whether the integration needs a small behavior hook.

Metadata is enough for integrations that only add packages or plugin settings to
an existing generated config. A Stylelint plugin, for example, can often declare
its package dependency, parent `stylelint` integration, plugin name, and rules in
the catalog. An Oxlint plugin can often declare the plugin name and included
parent integration. In those cases, the existing config builders can consume the
catalog entry directly.

Custom behavior is needed when the integration crosses out of pure metadata. Use
Varlock as the example: it needed a package script, a starter `.env.schema`, a
small `.gitignore` merge, a `doctor` warning when the schema is missing, and
clear dry-run output. React Doctor is another familiar example: it needs package
scripts plus a generated `react-doctor.config.json`.

When an integration needs custom behavior, keep it narrow and keyed from the
resolved integration ID or platform in [`src/index.js`](../src/index.js). Add the
script, file plan, diagnostic, pointer, or dry-run output in the same flow that
already handles similar integrations, then protect that behavior with focused
tests.

The matching recipe entry a project developer would write is intentionally small:

```json
{
  "$schema": "https://calavera.schalkneethling.com/calavera.config.schema.json",
  "profile": "modern",
  "packageManager": "pnpm",
  "integrations": ["editorconfig", "typescript", "oxlint", "varlock"],
  "scripts": {
    "lint": true,
    "format:check": true,
    "typecheck": true,
    "quality": true
  }
}
```

That recipe should be enough for the CLI to resolve Varlock from the catalog.
Today the composer still has its own compact browser catalog, so contributor
changes may need to update `web/script.js` too. A future improvement should make
the composer derive from the shared catalog so this duplication disappears.

## Add Dependencies Through Metadata

Varlock did not need installer code. The catalog entry declared
`dependencies: ["varlock"]`, and the existing `apply` flow collected dependency
metadata from the resolved integrations.

For ordinary npm development dependencies, the catalog is the path. If a package
should be installed whenever the integration is selected, put it in
`dependencies`.

A separate installer should be rare and should start with a design discussion,
not a one-off branch in `apply`. Reach for a new installer path only when the
integration cannot be represented as package-manager development dependencies.
Examples might include a tool that requires a non-npm runtime, a local binary
outside `node_modules`, a service bootstrap step, or authentication with an
external platform. In those cases, the contribution should explain why package
metadata is not enough, how dry-run and `--json` output will describe the work,
and how Calavera will avoid hidden machine-level state.

## Add Package Scripts Deliberately

An integration contributor does not manually edit a target project's
`package.json`. Instead, they update Calavera's script-building logic so future
projects receive ordinary package scripts when they run `apply`.

The Varlock contribution added an `env:load` script:

```json
{
  "env:load": "varlock load"
}
```

It also wired that script into the aggregate command used by the recipe. When
Theo opened PR #127, that aggregate script was named `check`. Calavera has since
renamed it to `quality`, so a new integration should follow the current
`quality` model in [`src/index.js`](../src/index.js) rather than copying the old
`check` name from the PR.

Use the tool's real validation command as the script body. Varlock uses
`varlock load` because it prints the resolved redacted environment and exits
non-zero on schema violations.

For a `pnpm` project that already has lint, format, and type-check scripts, the
Varlock-specific result should look like this:

```json
{
  "scripts": {
    "env:load": "varlock load",
    "quality": "pnpm lint && pnpm format:check && pnpm typecheck && pnpm env:load"
  }
}
```

The important shape is that Varlock gets its own readable script, and the
aggregate script invokes it through the selected package manager.

## Decide What Calavera Owns

Before adding file behavior, decide whether each destination is Calavera-managed
or project-owned.

Managed files are generated from the recipe and recorded in
`.calavera/state.json` with hashes. Calavera can later inspect, update, and clean
them because it knows exactly what it wrote. Examples include generated lint
configs, `tsconfig.json`, React Doctor config, and helper scripts.

Project-owned files are different. Calavera may create a starter file or merge a
small block into an existing file, but it should not later assume ownership. The
Varlock contribution treated these as project-owned:

- `.env.schema`: scaffolded only when missing because teams will edit it with
  real environment requirements.
- `.gitignore`: merge-appended with Varlock's recommended lines without
  duplicating existing entries.

Those files were intentionally not added to `.calavera/state.json`. That matters:
if a project developer later removes `varlock` from the recipe and runs `clean`,
Calavera should not delete environment schema data or a project `.gitignore`
that may now contain unrelated local intent.

As a rule of thumb:

- Generate and track Calavera-owned files when Calavera can recreate the whole
  file safely from the recipe.
- Scaffold project-owned files when the generated content is only a starter.
- Merge project-owned files when Calavera needs to add a small conventional block.
- Never overwrite or clean project-owned files just because an integration was
  selected once.

A starter `.env.schema` is a good scaffold because it gives project developers a
valid first file without pretending Calavera knows their production secrets:

```dotenv
# @defaultSensitive=false
# @defaultRequired=infer

# Application environment
# @type=enum(development, staging, production)
# @required
APP_ENV=development
```

The `.gitignore` merge is also project-owned. The integration can append the
missing Varlock lines under a small heading:

```gitignore
# Varlock
!.env.schema
!.env.*
.env.local
```

In this post, scaffold means "create a starter file only when the file does not
already exist." Merge means "append only the missing Calavera-recommended lines
to an existing project-owned file." Generate means "write the full file from the
recipe and track it as Calavera-managed."

After `apply`, scaffolded and merged files should not appear in managed state. A
state file for a recipe that includes Varlock should track files Calavera fully
generates and owns, but not `.env.schema` or `.gitignore`:

```json
{
  "version": 1,
  "profile": "modern",
  "integrations": ["editorconfig", "typescript", "oxlint", "varlock"],
  "files": [".editorconfig", ".calavera/run-if-files.mjs", "oxlint.json", "tsconfig.json"],
  "managedFiles": [
    {
      "path": ".editorconfig",
      "hash": "..."
    },
    {
      "path": ".calavera/run-if-files.mjs",
      "hash": "..."
    },
    {
      "path": "oxlint.json",
      "hash": "..."
    },
    {
      "path": "tsconfig.json",
      "hash": "..."
    }
  ]
}
```

## Implement Apply Behavior

`apply` should make the selected recipe real while preserving local edits.

The Varlock apply behavior did three things:

1. Added `varlock` to the development dependency list through the catalog.
2. Added `env:load` and included it in the aggregate quality script.
3. Scaffolded `.env.schema` and merged Varlock ignore rules into `.gitignore`.

The important detail is idempotency. A second `apply` should not duplicate
`.gitignore` lines, and it should not replace a developer's edited
`.env.schema`. For scaffolded files, check whether the destination exists before
writing. For merged files, compare normalized lines and append only the missing
ones.

Calavera already handles safety checks for managed files through its existing
state and hash logic. An integration contributor only needs custom checks for
project-owned files that Calavera intentionally does not track. Varlock needed
that custom branch because `.env.schema` and `.gitignore` are assets project
developers are expected to edit.

Dry-run output should also describe the intent accurately. The current
`apply --dry-run --json` payload uses the shared `changes` shape from
[`src/index.js`](../src/index.js): `type`, `path`, and optional fields such as
`scripts` and `removedDefaultTestScript`. It does not currently include
ownership markers such as `managed` or `scaffold`.

A useful dry-run result for a fresh project would therefore include changes like:

```json
{
  "command": "apply",
  "dryRun": true,
  "packageManager": "pnpm",
  "dependencies": ["typescript", "@types/node", "oxlint", "varlock"],
  "integrations": ["editorconfig", "typescript", "oxlint", "varlock"],
  "changes": [
    {
      "type": "update",
      "path": "package.json",
      "scripts": ["lint", "format:check", "typecheck", "env:load", "quality"]
    },
    {
      "type": "write",
      "path": ".editorconfig"
    },
    {
      "type": "write",
      "path": ".calavera/run-if-files.mjs"
    },
    {
      "type": "write",
      "path": "oxlint.json"
    },
    {
      "type": "write",
      "path": "tsconfig.json"
    },
    {
      "type": "write",
      "path": ".env.schema"
    },
    {
      "type": "update",
      "path": ".gitignore"
    }
  ],
  "pointers": []
}
```

The corresponding human output should follow the current dry-run printer:

```text
Would update package.json
Would add scripts: lint, format:check, typecheck, env:load, quality
Would write .editorconfig
Would write .calavera/run-if-files.mjs
Would write oxlint.json
Would write tsconfig.json
Would write .env.schema
Would update .gitignore
```

Because the change list does not encode ownership, use the surrounding
documentation, state-file assertions, and tests to make the managed versus
project-owned distinction clear.

## Add Doctor Coverage

`doctor` should report missing project assets that Calavera expects for the
selected recipe.

For Varlock, the useful diagnostic is simple: if the recipe includes `varlock`
but `.env.schema` is missing, `doctor` should warn. That warning is helpful in
human output and in `doctor --json` so CI and agent workflows can make the same
decision a person would make after reading the terminal.

Prefer diagnostics that explain missing prerequisites, stale generated files, or
unsafe drift. Avoid diagnostics that try to reimplement the integration tool's
own validator. Varlock itself should validate the schema and environment values;
Calavera only needs to notice when the project is missing the schema file that
the recipe expects.

For example, if a recipe selects Varlock but `.env.schema` has been deleted,
`doctor --json` should expose a machine-readable warning with the same file path
humans need to inspect:

```json
{
  "command": "doctor",
  "ok": false,
  "issues": [
    {
      "level": "warning",
      "path": ".env.schema",
      "message": "Missing Varlock schema file. Run create-project-calavera apply to scaffold .env.schema."
    }
  ]
}
```

The exact message can evolve with the CLI, but the contract should stay clear:
the recipe selected Varlock, the expected schema is absent, and `apply` can
restore the starter file.

## Expose the Integration in the Composer

The web composer should not drift from the CLI catalog model. When a new
integration should be available in the composer, expose it in
[`web/script.js`](../web/script.js) with the same ID, label, group, and status
language used by the CLI.

For Varlock, that meant adding it to the Environment variables group so a project
developer could include it in a generated `calavera.config.json` without
hand-editing the recipe. This currently duplicates the shared catalog entry in
the compact helper format used by the browser UI:

```js
entry("varlock", "Environment variables", "Varlock", "optional");
```

If the composer exports a schema or static catalog artifact for the browser,
update the matching test or drift check. Calavera's public recipe schema lives at
[`web/public/calavera.config.schema.json`](../web/public/calavera.config.schema.json),
and repository drift checks live in
[`scripts/check-config-schema.test.mjs`](../scripts/check-config-schema.test.mjs).

Longer term, the right shape is for the composer to consume the shared catalog
instead of requiring contributors to update both places by hand.

## Test the Contribution

A good integration test plan should cover behavior, idempotency, diagnostics, and
machine-readable output.

The Varlock contribution's test plan is a useful checklist:

- applying a recipe with `varlock` adds the dependency and scripts;
- a fresh project gets a starter `.env.schema`;
- an existing `.env.schema` is preserved on re-apply;
- `.gitignore` receives the Varlock lines once, without duplicates;
- `doctor --json` warns when `.env.schema` is missing;
- `apply --dry-run` reports scaffold and update changes clearly;
- `.calavera/state.json` does not list project-owned scaffolded files;
- lint or repository checks still pass.

Keep the test tool matched to the risk. For a normal catalog integration, that
usually means ordinary tests around the behavior the integration adds: resolved
dependencies, package scripts, file ownership, dry-run output, and `doctor`
diagnostics. Schema validation only matters when the integration changes
`calavera.config.json` structure or the published recipe schema.

In practice, that can be written as focused fixture-style tests. The exact helper
names depend on the test harness, but the assertions should stay this concrete:

```js
test("varlock scaffolds project-owned files without tracking them as managed", async () => {
  const project = await createFixtureProject({
    "calavera.config.json": JSON.stringify({
      profile: "modern",
      packageManager: "pnpm",
      integrations: ["editorconfig", "varlock"],
      scripts: { quality: true },
    }),
  });

  await runCalavera(project, ["apply", "--no-install", "--yes"]);

  assert.equal(await project.read(".env.schema"), expectedVarlockSchema);
  assert.match(await project.read(".gitignore"), /# Varlock/);
  assert.match(await project.read("package.json"), /"env:load": "varlock load"/);

  const state = JSON.parse(await project.read(".calavera/state.json"));
  assert.equal(state.files.includes(".env.schema"), false);
  assert.equal(state.files.includes(".gitignore"), false);
});

test("varlock apply is idempotent around project-owned files", async () => {
  const project = await createFixtureProject({
    "calavera.config.json": JSON.stringify({
      profile: "modern",
      packageManager: "pnpm",
      integrations: ["varlock"],
    }),
    ".env.schema": "APP_ENV=production\nCUSTOM_TOKEN=\n",
    ".gitignore": "# Varlock\n!.env.schema\n!.env.*\n.env.local\n",
  });

  await runCalavera(project, ["apply", "--no-install", "--yes"]);
  await runCalavera(project, ["apply", "--no-install", "--yes"]);

  assert.equal(await project.read(".env.schema"), "APP_ENV=production\nCUSTOM_TOKEN=\n");
  assert.equal((await project.read(".gitignore")).match(/\.env\.local/g).length, 1);
});
```

Those examples are illustrative, not a requirement to introduce those exact
helpers. The important part is that the test names and assertions protect the
integration contract a future maintainer might accidentally break.

## Use Post-Install Pointers for Concise Follow-Up

Some integrations finish `apply` successfully but still need the project
developer to do one small thing next. That is where post-install pointers belong.

Calavera already returns post-install pointers from `apply` in both
human-readable output and JSON output. The existing AI artifact flow uses this
mechanism to surface concise follow-up guidance, and future integrations can use
the same pattern when a normal change list is not enough.

Use a pointer when:

- the integration installed correctly, but the project developer must review or
  connect a generated fragment before another tool consumes it;
- a scaffolded starter file needs a short next action, such as filling in
  project-specific values;
- the guidance is useful to humans and automation reading `apply --json`.

Do not use a pointer for verbose documentation, warnings that belong in
`doctor`, or details already clear from the change list. Keep each pointer short,
specific, and actionable.

For a Varlock-style integration, a useful pointer might be:

```text
Review .env.schema and add required project environment variables before enabling env:load in CI.
```

Pointers should be available in JSON as stable strings so agents can display,
summarize, or route them. They should also print in human output after `apply`
so project developers see the same follow-up without needing `--json`.

For example, if Varlock chose to emit a pointer after scaffolding the starter
schema, the `apply --json` shape should remain simple:

```json
{
  "command": "apply",
  "dryRun": false,
  "pointers": [
    "Review .env.schema and add required project environment variables before enabling env:load in CI."
  ]
}
```

The human output should print the same sentence after the change list:

```text
Review .env.schema and add required project environment variables before enabling env:load in CI.
```

Start from the current pointer behavior in
[`src/index.js`](../src/index.js) and the documented contract in
[`docs/ai-module-contract.md`](ai-module-contract.md#post-install-pointers).

## Contributor Starting Points

When adding the next integration, begin with these files:

- [`src/catalog.js`](../src/catalog.js): shared integration metadata.
- [`src/index.js`](../src/index.js): script building, managed files, `apply`,
  `doctor`, result printing, and JSON output.
- [`web/script.js`](../web/script.js): composer exposure for selectable
  integrations.
- [`web/public/calavera.config.schema.json`](../web/public/calavera.config.schema.json):
  public recipe schema.
- [`scripts/check-config-schema.test.mjs`](../scripts/check-config-schema.test.mjs):
  catalog/schema drift and contract checks.
- [`README.md`](../README.md): public integration catalog summary.

The shortest successful path is usually: catalog entry first, script behavior
second, file ownership decision third, `apply` and `doctor` behavior fourth,
composer exposure fifth, and tests around the contract you just created.
