# ADR-0018: Responsibilities of the CLI, the MCP Server, and WebMCP

- **Status:** Accepted (2026-11-18, Schalk Neethling, merged in #1045)
- **Date:** 2026-11-18
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/354
- **Decides:** which of Calavera's three agent-facing surfaces owns which work. The CLI is the reference surface for changing a project and for reporting on Calavera's own state: every new capability of that kind exists there first, and the lifecycle commands, including `eject` once it ships, stay CLI-only unless a later issue shows that a structured tool adds something a `--json` flag does not. Finding options belongs to the standard Model Context Protocol (MCP) server and the Composer, inspecting a project belongs to the MCP server, and the CLI gains no read-only command for either. The MCP server is a thin adapter for discovery, explanation, and recipe composition, and it keeps its two-step apply (`dry_run_apply`, then `apply_recipe`) long term. WebMCP, the set of tools the Composer web page registers for an agent in the browser, is a constrained adapter for the same discovery and composition tools, with listed differences that follow from running in a browser. All three call one shared application core in the same process; none runs another as a child process. The bundled Calavera skill keeps its fallback, the Composer and then `apply --dry-run`, and uses only the tools the MCP server lists. No MCP or WebMCP tool is removed, renamed, or changed in shape in this release, and each later breaking change to a public tool needs its own decision issue, ADR, and pull request (Decision 6). This document changes no code. The owner answered the open questions of the first draft on 2026-11-18 on #354, and each answer is recorded in the decision it belongs to. After accepting this ADR, the owner filed the implementation issues #1051, #1052, and #1053.

## Context

Issues #198 and #199 made the MCP server and the Composer's WebMCP tools parity surfaces for recipe composition: the same tool names and the same response shapes for the same questions. After using the finished system on real projects, the owner asked whether agents, which now work well through ordinary CLI commands, still need MCP for project mutation and deterministic workflows, or whether MCP should become a thin wrapper or a read-oriented discovery and explanation surface (#354). The owner decided on 2026-11-14 to keep #354 in the `cli-experience` release as a document only.

The css-evolve MCP server is out of scope: Calavera installs its registration and does not proxy or wrap its tools (interface contract I6, `docs/cross-repo/interface-contract.md`).

The C8 safety properties of the evolution brief (`docs/evolution-brief.md`, Section 3) constrain every option. Decision 9 states how each of the five holds.

## What each surface does today

The three surfaces share one application core. The MCP server imports `recipe.js`, `baseline-core`, and the inspection and apply functions; the Composer imports `recipe.js`, `baseline-core`, and `packages/cli/src/ai/catalog.js`. Neither runs the CLI as a child process. The inspection and apply part of the core currently lives in the CLI's entry file, `index.js`, next to the CLI's argument handling.

```
                 packages/cli/src/recipe.js        (catalog, compose, validate, explain)
                 packages/baseline-core            (Baseline targets and features)
                 packages/cli/src/index.js         (inspectProject, applyRecipeObject: the apply pipeline)
                        ▲            ▲            ▲
          ┌─────────────┘            │            └──────────────┐
   CLI (index.js)          MCP server (mcp.js)          Composer WebMCP (apps/composer/script.js)
   command-line args       tool call over stdio         tool call in the browser
   → core                  (standard input and output)  (navigator.modelContext)
                           → core                       → core
   writes projects         writes through apply_recipe  writes nothing in a project
```

### The CLI

The CLI commands that change a project are `init`, `agent-init` (and its alias `bootstrap`, or the `--init` flag), `--new`, `apply`, `update`, `clean`, and the `artifacts` commands `install`, `migrate`, and `update`. The commands that check a project are `doctor`, `artifacts status`, and `artifacts doctor` (`formatHelp` in `packages/cli/src/index.js`). `apply --dry-run --json` prints the dry run as JSON.

The CLI can compose without prompts: `init --yes --profile <id> --tool <id> --ai-artifact <id> --json` writes a recipe. It has no read-only command that lists or describes the catalog, and no command that reports what `inspect_project` reports: the project's existing tooling and its conflicts with the catalog. `doctor` and `artifacts status` report only on Calavera's own files. An agent without MCP can therefore compose only if it already knows the IDs, and it can answer "which Stylelint plugins are available?" only through the Composer, the interactive `init` wizard, or the source.

### The MCP server

`packages/cli/src/mcp.js` registers 14 tools:

- Twelve discover, compose, or explain: `inspect_project`, `list_profiles`, `list_integrations`, `describe_integration`, `list_ai_artifacts`, `list_baseline_targets`, `describe_baseline_target`, `search_baseline_features`, `recommend_baseline_target`, `compose_recipe`, `validate_recipe`, and `explain_recipe`.
- `dry_run_apply` previews a write and changes no files. It and the twelve tools above carry `readOnlyHint: true`.
- `apply_recipe` writes, and it carries `readOnlyHint: false` and `destructiveHint: true`.

Each handler translates its input into calls to the core. `dry_run_apply` and `apply_recipe` both call `applyRecipeObject`, the function the CLI's `apply` uses (`mcp.js`, `dryRunApplyTool` and `applyRecipeTool`). `compose_recipe` also reports three things that need Node.js and the project directory: the inputs each selected artifact declares, the integration options Calavera suggests a value for, and whether the project uses Vite+ (`reportVitePlus`). `explain_recipe` reports the Vite+ result too. The server runs one tool call at a time, because the tools read the working directory and `apply_recipe` may change it when it applies the recipe in a parent directory's project (#430).

The bundled Calavera skill (`packages/artifacts/skill-calavera/payload/calavera/SKILL.md`) tells an agent to use these tools and, when they are missing, to help the person register the server. If the server cannot be registered, its "Fallbacks" section sends the agent to the hosted Composer to compose and download a recipe, and then to the pinned CLI's `apply --dry-run` for a preview the person approves before `apply`.

### WebMCP in the Composer

`apps/composer/script.js` registers 12 tools through `navigator.modelContext.registerTool`: the eleven MCP tools that need no project (every tool above except `inspect_project`, `dry_run_apply`, and `apply_recipe`) under the same names, plus `download_recipe`, which saves the recipe as `calavera.config.json`. A web page cannot read or write the person's project, which is why the other three are missing.

> **Note (2026-11-23, #1192):** The WebMCP specification (Draft Community Group Report, 19 November 2026, section 4.1, "Extensions to Document") defines `modelContext` on `Document`, and Chrome's imperative API guide (last updated 20 November 2026) calls `document.modelContext.registerTool`. Neither source documents `navigator.modelContext`. The Composer now registers its tools through `document.modelContext.registerTool` only. The `navigator.modelContext` in the diagram and in this section records the object the Composer used when this ADR was accepted.

The hosted page may be newer than the CLI a person runs, so the Composer checks its results against the latest published CLI version, or against version 2.2.0 (`SAFE_CLI_FALLBACK_VERSION`) when it cannot reach the npm registry (`apps/composer/cli-compatibility.js`). `list_integrations` and `list_ai_artifacts` filter out what that version does not support, and `list_profiles` trims each profile's default integrations to it; `describe_integration`, `compose_recipe`, `validate_recipe`, and `explain_recipe` reject what it does not support; the Baseline tools are not checked.

`packages/cli/scripts/mcp-tool-list-docs.test.mjs` checks the MCP tool list against the README, `--help`, the bundled skill, and `docs/agent-first-calavera-workflow.md`, and the WebMCP tool list against the workflow document.

### Where the two tool surfaces differ under one name

Descriptions mostly come from one place, `recipeToolDescriptions` and `recipeToolInputDescriptions` in `packages/cli/src/recipe.js`. Input schemas do not: the MCP server declares them with Zod in `mcp.js`, and the Composer declares them as hand-written JSON Schema in `script.js`. Nothing tests that the two schemas for one tool name accept the same inputs. The differences known today are these:

| Difference                                                                                                                                                                                                | Cause                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| MCP `compose_recipe` uses `mcpComposeRecipeDescription`, which promises the artifact and integration inputs; WebMCP uses `recipeToolDescriptions.compose_recipe`.                                         | Intentional: only Node.js can compute those inputs (`recipe.js`, comment on `mcpComposeRecipeDescription`). |
| MCP accepts `inputs` on each AI artifact in `compose_recipe`; WebMCP does not.                                                                                                                            | Intentional, for the same reason.                                                                           |
| MCP accepts any object as `integrationOptions`; WebMCP declares a strict schema for each integration, which repeats the CodeQL language list of `packages/cli/src/github-repository-controls-options.js`. | Unintended: two hand-written schemas.                                                                       |
| MCP declares an output schema for `list_integrations` and `describe_integration`; WebMCP declares none.                                                                                                   | Unintended.                                                                                                 |
| MCP annotations carry `destructiveHint`, `idempotentHint`, and `openWorldHint`; WebMCP annotations carry `untrustedContentHint`.                                                                          | Intentional: each follows its own protocol's annotation set (Decision 4).                                   |

## Approaches compared

| Approach                                                                                                                                                                         | Pros                                                                                                                                                                                                                                                                                                                                        | Cons                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current parity.** MCP and WebMCP mirror each other for composition, MCP also applies, and the CLI has commands but no discovery.                                               | Nothing changes for existing MCP users. Structured inputs and outputs suit composition, which has many enumerated choices. The tool sequence makes the approval boundary explicit.                                                                                                                                                          | Every new capability needs design for three surfaces. Lifecycle work (`update`, `clean`, `artifacts`) exists only in the CLI, so parity covers composition alone. An agent without MCP can discover the catalog only through the Composer, which needs a browser. Two schema definitions per shared tool have already drifted (see the table above).                                                |
| **Thin-wrapper MCP.** Every MCP tool runs a CLI command as a child process and returns its JSON output.                                                                          | One implementation of each behavior, the CLI. MCP and CLI behavior cannot diverge.                                                                                                                                                                                                                                                          | A child process per call, with argument quoting and output parsing. Errors lose their structured cause chain across the process boundary unless the CLI serializes it, which works against keeping failures diagnosable. WebMCP cannot start a process at all, so it still needs the in-process core. An in-process call to the same core gives the same single implementation without these costs. |
| **CLI-first.** The CLI is the reference surface for every behavior, and MCP and WebMCP are adapters over the shared core for the subset that benefits from structured discovery. | Agents that work through shell commands get every capability that changes a project, including a dry run that is already JSON. New features ship once, in the CLI and the core, and MCP gains a tool only when structured discovery helps. It serves the one-source-of-truth goal of #354, because each behavior has one reference surface. | An agent without MCP gets every capability only if the CLI also gains read-only discovery commands, which add a public surface. Decision 1 keeps discovery out of the CLI, so such an agent still finds option IDs through the Composer. Existing MCP users see no immediate change, so the benefit comes from what Calavera does not build, not from what it removes.                              |

## Decision

### 1. The CLI is the reference surface

Every new capability that changes a project, or that reports on a project's Calavera state, exists as a CLI command first. The contributor designs and tests it as a CLI command and a core function before considering an MCP or WebMCP tool. The lifecycle commands, `update`, `clean`, `doctor`, the `artifacts` commands, and `eject` once #678 ships it (ADR-0017), stay CLI-only unless a later issue shows that a structured tool adds something a `--json` flag does not. Artifact status is the one exception this ADR names, in Decision 3.

Finding options and inspecting a project are not CLI responsibilities. The CLI gains no read-only command that lists or describes option IDs, such as integrations, AI artifacts, or Baseline targets, and no command that reports what `inspect_project` reports. Finding options stays with the MCP server and the Composer, and `inspect_project` stays MCP-only. The owner decided this on 2026-11-18 (#354).

### 2. One application core, called in the same process

The CLI, the MCP server, and the Composer are adapters over one core. The core is `baseline-core` and every module of the CLI package that is not an adapter, not a closed list. Today it includes `recipe.js` for the catalog, composition, validation, and explanation; `ai/catalog.js` for the AI artifact catalog; `inspectProject`, `applyRecipeObject`, and `reportVitePlus` in `index.js` for inspection, the apply pipeline, and the Vite+ result; and `describeArtifactInputs` (`ai/artifact-inputs.js`) and `describeIntegrationInputs` (`integration-inputs.js`), which the MCP server's `compose_recipe` already calls. An adapter translates its transport's input into a core call and the core's result into its transport's output, and it holds no catalog, validation, composition, or explanation logic of its own. MCP does not run the CLI as a child process, because an in-process call keeps structured results and the error cause chain that `toolErrorResult` reports.

The input schema of a tool that MCP and WebMCP share comes from one definition in the core. Where only Node.js can serve part of a tool, such as the artifact `inputs` of `compose_recipe`, the core definition marks that part as Node.js-only, and the WebMCP adapter leaves it out. The schema stays one definition, so the surfaces cannot drift apart unnoticed.

The shared schema declares only what the core already accepts at runtime. For example, MCP declares `integrationOptions` as any object, but `recipe.js` rejects an option ID other than the four it supports (`stylelint-baseline`, `html-validate`, `github-repository-controls`, and `stryker`) with "Unknown integrationOptions". Declaring that narrower shape in MCP is therefore not a breaking change under Decision 6, because no input the core accepted before is refused after. A declared schema that would refuse an input the core accepts today is a breaking change and follows Decision 6.

### 3. The MCP server is for discovery, explanation, composition, and the two-step apply

The MCP server keeps its twelve discovery, composition, and explanation tools, because structured, enumerated choices are where tool calls help most: an agent learns valid IDs from `list_integrations` instead of guessing a flag value. It keeps `dry_run_apply` and `apply_recipe` with their current names and inputs, because C8 names `dry_run_apply` as the approval boundary and existing registrations rely on both. The owner decided on 2026-11-18 (#354) that `apply_recipe` stays an MCP tool long term. It is the documented end of the MCP flow, and it already runs the CLI's apply pipeline.

The owner adds a new mutating MCP tool only through its own decision issue. Artifact status is the one read-only MCP tool that reports project state this ADR adds, as an adapter over the same core function as its CLI command. Any further read-only tool of that kind needs the later issue that Decision 1 requires. The brief's task CAL-041, which ships `artifacts status`, asks for artifact status "from the CLI and MCP"; #398 delivered the CLI command, and no MCP tool reports it yet. The tool lets an agent in the MCP flow see that an artifact has an update before it composes or applies, without leaving the tool sequence for a shell command. `artifacts status` is offline by default and reports an available update only with `--check-updates`, which contacts the registry (`packages/cli/src/artifact-lifecycle.js`). The tool therefore takes an optional `checkUpdates` input. Its annotations mark it read-only and declare `openWorldHint: true`, because a call with `checkUpdates` contacts the registry; the shared `toolAnnotations.read` set in `mcp.js` declares `openWorldHint: false`, so it does not fit as it is. With `--check-updates`, the CLI also writes the artifact cache and its `.gitignore` block and records the block in the state (#960); the tool's `checkUpdates` path writes nothing. #1052 tracks the tool.

### 4. WebMCP is the browser-constrained composition surface

WebMCP offers the MCP server's discovery, Baseline, composition, validation, and explanation tools under the same names and response shapes, with these intentional differences:

| Difference                                                                                                                                                                                                   | Why                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| No `inspect_project`, `dry_run_apply`, or `apply_recipe`.                                                                                                                                                    | A web page cannot read or write the person's project.                              |
| Adds `download_recipe`.                                                                                                                                                                                      | Saving the recipe is how a composition leaves the browser.                         |
| `compose_recipe` neither accepts artifact `inputs` nor reports artifact inputs, integration inputs, or the Vite+ result, and its description does not promise them. `explain_recipe` omits the Vite+ result. | These need Node.js, Git, or the project directory, which the browser cannot reach. |
| Catalog and recipe results are checked against the latest published CLI version (2.2.0 when the registry is unreachable). The Baseline tools are not checked.                                                | The hosted page may be newer than the CLI that will apply the recipe.              |
| The `workflow` list in the `list_profiles` and `compose_recipe` responses names the WebMCP tools, because the Composer passes `{ browser: true }` to `recipeWorkflow`; MCP lists its own tools.              | Each surface tells the agent which tools it can call next.                         |
| `list_ai_artifacts` fills `currentConfiguration` with the AI artifacts selected on the page; MCP returns an empty list.                                                                                      | The Composer holds a recipe in progress; the MCP tool has no recipe to read.       |
| WebMCP annotations carry `readOnlyHint` and `untrustedContentHint`; MCP annotations carry `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.                                          | Each follows its own protocol's annotation set.                                    |

The unintended differences listed in "Where the two tool surfaces differ under one name" are gaps, and follow-up 1 (#1051) closes them. Any difference that this table does not list and that follow-up 1 does not close needs its own decision issue.

### 5. Single source of truth

Catalog data, validation rules, composition, and explanation text live only in the core. Descriptions already do, and input schemas join them under Decision 2. The existing tool-list drift test stays, and a schema drift test joins it.

### 6. Compatibility and the path for changing a public tool

No MCP or WebMCP tool is removed, renamed, or changed in shape in this release.

A later breaking change to a public tool follows the repository's removal rule. A breaking change removes or renames a tool, narrows the inputs it accepts, or removes or retypes a field of its output. Adding an optional input or an output field is not breaking and needs no ADR; the css-evolve diagnostics that brief task CAL-033 plans to add to `dry_run_apply` and `apply_recipe` are an example. Each breaking change needs its own decision issue, ADR, and pull request. The change is complete when it ships, and it leaves no deprecated alias or legacy mode. A changeset names the tool and its replacement. Each group of users meets the change at a different time:

| Users                                                            | When they meet the change                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| MCP registrations that `agent-init` wrote                        | When someone changes the pinned version, `create-project-calavera@<version>`, in the registration. |
| MCP registrations without a version                              | On the next launch after the release.                                                              |
| Agents using the Composer's WebMCP tools                         | When the hosted Composer deploys.                                                                  |
| Projects that update the bundled skill but keep an older MCP pin | When the skill names a tool the pinned server does not have.                                       |

The release notes name the replacement for every group. Decision 7 covers the last row.

### 7. The bundled skill

The bundled Calavera skill keeps its fallback for an agent without MCP: compose and download a recipe in the Composer, then preview it with the pinned CLI's `apply --dry-run` and run `apply` after the person approves. It gains no CLI discovery step, because Decision 1 adds no CLI discovery commands.

The skill tells the agent to use only the tools the MCP server lists. A skill that is newer than the project's pinned server may describe a tool the server does not have; the agent then works with the listed tools instead of calling a missing one. This needs no version coupling between the skill and the server: `artifacts update` updates the skill, and the MCP pin changes separately. The owner decided both points on 2026-11-18 (#354).

### 8. Follow-up work waited for acceptance

The owner filed the implementation issues after accepting this ADR: #1051, #1052, and #1053. Consequences lists what each covers.

### 9. How C8 holds

- **Only the CLI writes into projects.** This ADR adds no writer. `apply_recipe` was part of the MCP server when the brief recorded C8 (brief Section 2 lists it), and it runs `applyRecipeObject` in the CLI package. WebMCP writes nothing in a project; `download_recipe` saves a file through the browser.
- **`dry_run_apply` is the approval boundary.** This is unchanged. Decision 3 keeps both tools, and no new mutating tool arrives without a decision issue.
- **Local edits are preserved.** This is unchanged, because every write still goes through the existing pipeline.
- **Artifacts are not recorded in `package.json`.** This is unchanged, for the same reason.
- **Conflicts surface as a hard stop or a migration decision.** This is unchanged, for the same reason.

## Consequences

The owner filed these follow-up issues after accepting this ADR:

1. #1051: Move the input and output schemas of each shared tool into the core, with Node.js-only parts marked, generate the Zod and JSON Schema forms from them, and add a test that MCP and WebMCP accept the same inputs and declare the same output schema for each shared tool name. This closes every unintended difference, including the repeated CodeQL language list and the output schemas that WebMCP lacks for `list_integrations` and `describe_integration`.
2. #1052: Add a read-only MCP tool for artifact status over the core function behind `artifacts status`, with an optional `checkUpdates` input and open-world annotations (Decision 3), to finish CAL-041.
3. #1053: Change the bundled skill so that the agent uses only the tools the MCP server lists (Decision 7). Today the skill names a fixed list of tools and tells the agent to stop and repair the registration when they are not available, which does not separate a missing server from an older one. `packages/cli/scripts/mcp-tool-list-docs.test.mjs` requires that list to equal the tools the server registers, so the follow-up changes that test too.

Existing MCP users see no change. The costs are that new lifecycle capabilities reach MCP users only through the CLI, which their agents can already run, and that an agent without MCP finds option IDs through the Composer, which needs a browser, or through the interactive `init` wizard, which needs a person at the prompts.

## Alternatives considered

**Keep full parity and extend it to lifecycle commands.** This was rejected because it triples the design and test work for each command and adds mutating MCP tools whose approval boundary would need its own decision, without evidence that agents need them as tools rather than commands.

**Make MCP read-only and remove `apply_recipe`.** The owner rejected this on 2026-11-18. Independently of that decision, the change would leave `dry_run_apply` as an approval boundary with nothing behind it in MCP, and it would break existing users.

**Add read-only CLI commands for option IDs and project inspection, and use them in the skill's fallback.** The owner rejected this on 2026-11-18: finding options stays with the MCP server and the Composer, and the skill's fallback stays as it is.

**Make MCP run the CLI as a child process.** This was rejected for the reasons in the comparison table: a process per call, lost error causes, and no benefit over an in-process call to the same core.
