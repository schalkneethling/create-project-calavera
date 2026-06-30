# Vite+ Template Research And Calavera Composition Plan

## Status

Research for
[#191 Research Vite+ create extension and Calavera MCP composition path](https://github.com/schalkneethling/create-project-calavera/issues/191).

This document is intentionally research and planning only. It does not ship a
future Calavera create package, a standard MCP server, or application starter
code.

## Sources Checked

- Vite+ docs:
  - [`vp create` guide](https://viteplus.dev/guide/create)
  - [`create` config reference](https://viteplus.dev/config/create)
- Vite+ source clone:
  - Repository: [`voidzero-dev/vite-plus`](https://github.com/voidzero-dev/vite-plus)
  - Commit checked: `914ca11070ba8bf7b0244dd638c017b99ad4ad66`
  - Main files inspected:
    - [`packages/cli/src/create/org-manifest.ts`](https://github.com/voidzero-dev/vite-plus/blob/914ca11070ba8bf7b0244dd638c017b99ad4ad66/packages/cli/src/create/org-manifest.ts)
    - [`packages/cli/src/create/org-resolve.ts`](https://github.com/voidzero-dev/vite-plus/blob/914ca11070ba8bf7b0244dd638c017b99ad4ad66/packages/cli/src/create/org-resolve.ts)
    - [`packages/cli/src/create/bin.ts`](https://github.com/voidzero-dev/vite-plus/blob/914ca11070ba8bf7b0244dd638c017b99ad4ad66/packages/cli/src/create/bin.ts)
    - [`packages/cli/src/create/discovery.ts`](https://github.com/voidzero-dev/vite-plus/blob/914ca11070ba8bf7b0244dd638c017b99ad4ad66/packages/cli/src/create/discovery.ts)
    - [`packages/cli/src/create/templates/bundled.ts`](https://github.com/voidzero-dev/vite-plus/blob/914ca11070ba8bf7b0244dd638c017b99ad4ad66/packages/cli/src/create/templates/bundled.ts)
    - [`packages/cli/src/create/__tests__/org-manifest.spec.ts`](https://github.com/voidzero-dev/vite-plus/blob/914ca11070ba8bf7b0244dd638c017b99ad4ad66/packages/cli/src/create/__tests__/org-manifest.spec.ts)

## Verified Vite+ Create Behavior

Vite+ supports organization template manifests through `createConfig.templates`
in a scoped `@scope/create` package. `vp create @scope` reads the npm packument
for `@scope/create`, looks for `createConfig.templates`, and opens a picker in
interactive mode.

The manifest entry shape is:

```json
{
  "name": "web",
  "description": "Web app template",
  "template": "@scope/template-web",
  "monorepo": false
}
```

`name`, `description`, and `template` are required strings. `monorepo` is
optional and must be a boolean when present. Duplicate names are rejected.
Names beginning with `__vp_` are reserved. Relative template paths that escape
the package root are rejected.

Supported `template` values include npm specifiers, GitHub URLs, Vite+ built-ins
such as `vite:application`, local workspace package names, and relative bundled
paths such as `./templates/demo`.

The scoped syntax is:

- `vp create @schalkneethling` - reads `@schalkneethling/create` and opens the
  manifest picker in interactive mode.
- `vp create @schalkneethling:web` - selects the manifest entry named `web`.
- `vp create @schalkneethling@1.2.3` or
  `vp create @schalkneethling:web@1.2.3` - pins the `@schalkneethling/create`
  manifest package version or dist tag.

The slash form, such as `@schalkneethling/web`, is not an org-picker specifier.
Vite+ leaves it to the existing create-package shorthand path.

If `vp create @scope` is run with `--no-interactive`, Vite+ prints the manifest
table and exits with code 1 because a specific entry is required. This is useful
for agents and CI that need to inspect available entries before choosing one.

`create.defaultTemplate` in `vite.config.ts` is also verified. With:

```ts
export default {
  create: {
    defaultTemplate: "@schalkneethling:demo",
  },
};
```

bare `vp create --no-interactive --directory default-demo` used the configured
manifest entry.

`create.templates` in `vite.config.ts` is a separate local-template surface for
monorepos. It accepts the shared `{ name, description, template }` entry shape,
but not the org-only `monorepo` flag. Local entries are resolved by name from
inside the monorepo and are not inferred from package metadata.

## Minimal PoC Result

I ran a throwaway PoC using the installed `vp v0.2.1` CLI and Vite+'s own mock
npm registry fixture pattern. The mock registry exposed a packument for
`@schalkneethling/create` with one bundled template:

```json
{
  "name": "demo",
  "description": "Bundled demo template",
  "template": "./templates/demo"
}
```

Command:

```sh
vp create @schalkneethling:demo --no-interactive --directory hello-calavera --package-manager pnpm --no-git --no-hooks --no-agent --no-editor
```

Result:

```text
Scaffolded hello-calavera
Node 24.18.0  pnpm 11.9.0
Dependencies installed in 8.1s
Next: cd hello-calavera && vp run
```

The generated project contained:

```text
README.md
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
src/index.ts
vite.config.ts
```

The package name was rewritten to `hello-calavera`, dependencies were installed,
and the generated source contained the expected hello-world file.

I also verified `vp create @schalkneethling --no-interactive` prints the
manifest table and exits 1, and verified `create.defaultTemplate` can drive a
bare `vp create` invocation.

## Post-Scaffold Commands

I did not find a template-declared post-scaffold hook in the verified
`createConfig.templates` surface. Bundled org templates are copied as static
directories. Non-bundled org entries resolve to a template command that Vite+
runs through the package manager, then Vite+ performs its own setup afterward:
agent instructions, editor config, git/hooks, package-manager setup, dependency
install, lint/format migration, Vite+ project rewrite, format, and summary.

That means `create-project-calavera apply` should not be modeled as a
`createConfig.templates` hook. It can still be automated, but the automation
needs to live in an executable orchestrator or in an agent workflow that runs
Vite+, writes `calavera.config.json`, runs Calavera apply, and then runs project
checks.

## Recommended Direction

The Vite+ integration points are useful, but a tight Vite+ integration is not
the highest-leverage next step. Calavera should stay project-agnostic and work
after any scaffold, including Vite+, another starter, or an existing project.

The preferred implementation order is:

1. Agent-first composition through MCP with a parity WebMCP surface.
2. A rich interactive CLI composer.
3. Web UI refinements that generate the exact project-local apply commands.

This keeps Vite+ as a complementary scaffold option rather than making it the
center of the product architecture.

## Recommended Command Flows

Agent-first flow:

```text
vp create
cd generated-project
npm create @schalkneethling/project-calavera -- --init
start an agent
ask the agent to use the Project Calavera skill
describe linting, formatting, TypeScript, and AI artifact needs
agent composes a recipe through MCP or WebMCP
agent presents the proposed recipe and dry-run summary
user approves
agent runs the Calavera apply command
```

The `vp create` step remains separate because:

- `vp create` may not be usable inside an existing project directory;
- users may choose a different scaffold tool;
- users may apply Calavera to existing projects.

Rich CLI flow:

```text
vp create
cd generated-project
npm create @schalkneethling/project-calavera
select tooling and AI artifacts in the interactive CLI
write calavera.config.json
run the printed apply command
```

Web UI flow:

```text
vp create
cd generated-project
save calavera.config.json from the Web UI
run the printed apply command
```

The CLI may later support a write-and-apply mode, but the durable contract should
remain the recipe file plus an explicit apply step.

## Package Naming Verification

The scoped npm create syntax was verified against npm 11.16.0 behavior:

```text
npm create @schalkneethling/project-calavera
  -> @schalkneethling/create-project-calavera@*
```

That means `@schalkneethling/create-project-calavera` can remain the published
package while the user-facing command uses the product-centered
`project-calavera` name. When passing arguments to the create package, docs
should use npm's argument separator:

```sh
npm create @schalkneethling/project-calavera -- --init
```

The `@schalkneethling/create` package name remains relevant only if Calavera
later publishes a Vite+ org manifest for `vp create @schalkneethling`.

## MCP And WebMCP Composition Surface

Recipe composition should be extracted into shared project logic first, not
duplicated between the web UI, WebMCP tools, future MCP server, and rich CLI.
That shared core is the main dependency for keeping the agent-first, CLI, and
Web UI paths in parity.

The shared surface should be able to power:

- existing web composer controls;
- existing WebMCP tools in `web/script.js`;
- future standard MCP tools;
- the rich interactive CLI composer;
- CLI commands that need recipe inspection or validation.

Candidate shared operations:

- `list_profiles`
- `list_integrations`
- `describe_integration`
- `list_ai_artifacts`
- `compose_recipe`
- `validate_recipe`
- `explain_recipe`
- `write_recipe`
- `dry_run_apply`
- `doctor_project`

The current WebMCP tools already expose these concepts partially:

- `get_project_tooling_options`
- `get_ai_artifact_options`
- `configure_project_tooling`
- `configure_ai_artifacts`
- `download_configuration_json`

The future standard MCP server should use the same catalog and recipe builders
as the web composer. It should not teach agents to drive the browser form when
the same recipe can be composed directly.

## Versioning Implications

Calavera's recipe composition and apply lifecycle should be versioned as the
durable tooling layer, independent of whichever app scaffold was used first.

- `create-project-calavera` version controls recipe application, generated
  tooling files, managed state, `doctor`, `update`, and `clean`.
- Generated projects should receive future tooling improvements through
  Calavera's recipe and update/apply lifecycle, not by rerunning a one-time app
  scaffold.
- `calavera.config.json` remains the durable handoff between composition and
  application.
- Future MCP, WebMCP, CLI, and Web UI surfaces should all use the same
  composition core so they stay in parity.

## Follow-Up Issues Filed

- [#197 Extract shared recipe composition core](https://github.com/schalkneethling/create-project-calavera/issues/197)
- [#198 Add standard MCP server for Calavera recipe composition](https://github.com/schalkneethling/create-project-calavera/issues/198)
- [#199 Align WebMCP tools with the MCP recipe composition contract](https://github.com/schalkneethling/create-project-calavera/issues/199)
- [#200 Add Calavera agent bootstrap init command](https://github.com/schalkneethling/create-project-calavera/issues/200)
- [#201 Build a rich interactive CLI recipe composer](https://github.com/schalkneethling/create-project-calavera/issues/201)
- [#202 Update web composer with project-local next commands](https://github.com/schalkneethling/create-project-calavera/issues/202)
- [#203 Document the agent-first Calavera workflow](https://github.com/schalkneethling/create-project-calavera/issues/203)
- [#204 Track agent-first Calavera composition roadmap](https://github.com/schalkneethling/create-project-calavera/issues/204)

## Explicit Non-Goal Preservation

Calavera should remain a tooling composer. It should not own application routes,
components, framework starter files, database setup, or deployment-specific app
code. Vite+ and selected application starters own app scaffolding. Calavera owns
the durable recipe, generated tooling configuration, managed state, update,
clean, doctor, and agent-readable recipe surfaces.
