# ADR-0018: Responsibilities of the CLI, the MCP Server, and WebMCP

- **Status:** Proposed (2026-11-18)
- **Date:** 2026-11-18
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/354
- **Decides:** which of Calavera's three agent-facing surfaces owns which work. The CLI is the reference surface: every new capability that changes a project or reports on it exists there first, and the lifecycle commands stay CLI-only. The standard Model Context Protocol (MCP) server is a thin adapter for discovery, explanation, and recipe composition, and it keeps its two-step apply (`dry_run_apply`, then `apply_recipe`) unchanged. WebMCP, the set of tools the Composer web page registers for an agent in the browser, is a constrained adapter for the same discovery and composition tools, with listed differences that follow from running in a browser. All three call one shared application core in the same process; none runs another as a child process. No public tool changes in this release, and a later breaking change to a public tool follows the path in Decision 6. This document changes no code. The owner creates the implementation issues after accepting it.

## Context

Issues #198 and #199 made the MCP server and the Composer's WebMCP tools parity surfaces for recipe composition: the same tool names and the same response shapes for the same questions. After using the finished system on real projects, the owner asked whether agents, which now work well through ordinary CLI commands, still need MCP for project mutation and deterministic workflows, or whether MCP should become a thin wrapper or a read-oriented discovery and explanation surface (#354). The owner decided on 2026-11-14 to keep #354 in the `cli-experience` release as a document only.

The css-evolve MCP server is out of scope: Calavera installs its registration and does not proxy or wrap its tools (interface contract I6, `docs/cross-repo/interface-contract.md`).

The C8 safety properties of the evolution brief (`docs/evolution-brief.md`, Section 3) constrain every option. Decision 8 states how each of the five holds.

## What each surface does today

The three surfaces share one application core. The MCP server imports `recipe.js`, `baseline-core`, and the inspection and apply functions; the Composer imports only `recipe.js` and `baseline-core`. Neither runs the CLI as a child process. The inspection and apply part of the core currently lives in the CLI's entry file, `index.js`, next to the CLI's argument handling.

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

The hosted page may be newer than the CLI a person runs, so the Composer checks its results against the latest published CLI version, or against version 2.2.0 (`SAFE_CLI_FALLBACK_VERSION`) when it cannot reach the npm registry (`apps/composer/cli-compatibility.js`). `list_integrations` and `list_ai_artifacts` filter out what that version does not support, and `list_profiles` trims each profile's default integrations to it; `describe_integration`, `compose_recipe`, `validate_recipe`, and `explain_recipe` reject what it does not support; the Baseline tools are not checked.

`packages/cli/scripts/mcp-tool-list-docs.test.mjs` checks the MCP tool list against the README, `--help`, the bundled skill, and `docs/agent-first-calavera-workflow.md`, and the WebMCP tool list against the workflow document.

### Where the two tool surfaces differ under one name

Descriptions mostly come from one place, `recipeToolDescriptions` and `recipeToolInputDescriptions` in `packages/cli/src/recipe.js`. Input schemas do not: the MCP server declares them with Zod in `mcp.js`, and the Composer declares them as hand-written JSON Schema in `script.js`. Nothing tests that the two schemas for one tool name accept the same inputs. The differences known today are these:

| Difference                                                                                                                                                                                                | Cause                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| MCP `compose_recipe` uses `mcpComposeRecipeDescription`, which promises the artifact and integration inputs; WebMCP uses `recipeToolDescriptions.compose_recipe`.                                         | Intentional: only Node.js can compute those inputs (`recipe.js`, comment on `mcpComposeRecipeDescription`). |
| MCP accepts `inputs` on each AI artifact in `compose_recipe`; WebMCP does not.                                                                                                                            | Intentional, for the same reason.                                                                           |
| MCP accepts any object as `integrationOptions`; WebMCP declares a strict schema for each integration, which repeats the CodeQL language list of `packages/cli/src/github-repository-controls-options.js`. | Unintended: two hand-written schemas.                                                                       |
| MCP checks the `recipe` input of `validate_recipe` and `explain_recipe` with a Zod record schema; WebMCP declares only `{ "type": "object" }`.                                                            | Unintended.                                                                                                 |
| MCP declares an output schema for `list_integrations` and `describe_integration`; WebMCP declares none.                                                                                                   | Unintended.                                                                                                 |
| MCP annotations carry `destructiveHint`, `idempotentHint`, and `openWorldHint`; WebMCP annotations carry `untrustedContentHint`.                                                                          | Each follows its own protocol's annotation set; nobody has reviewed them against each other yet.            |

## Approaches compared

| Approach                                                                                                                                                                         | Pros                                                                                                                                                                                                                                                                                                                                                                            | Cons                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current parity.** MCP and WebMCP mirror each other for composition, MCP also applies, and the CLI has commands but no discovery.                                               | Nothing changes for existing MCP users. Structured inputs and outputs suit composition, which has many enumerated choices. The tool sequence makes the approval boundary explicit.                                                                                                                                                                                              | Every new capability needs design for three surfaces. Lifecycle work (`update`, `clean`, `artifacts`) exists only in the CLI, so parity covers composition alone. An agent without MCP can discover the catalog only through the Composer, which needs a browser. Two schema definitions per shared tool have already drifted (see the table above).                                                |
| **Thin-wrapper MCP.** Every MCP tool runs a CLI command as a child process and returns its JSON output.                                                                          | One implementation of each behavior, the CLI. MCP and CLI behavior cannot diverge.                                                                                                                                                                                                                                                                                              | A child process per call, with argument quoting and output parsing. Errors lose their structured cause chain across the process boundary unless the CLI serializes it, which works against keeping failures diagnosable. WebMCP cannot start a process at all, so it still needs the in-process core. An in-process call to the same core gives the same single implementation without these costs. |
| **CLI-first.** The CLI is the reference surface for every behavior, and MCP and WebMCP are adapters over the shared core for the subset that benefits from structured discovery. | Agents that work through shell commands get every capability, including a dry run that is already JSON. New features ship once, in the CLI and the core, and MCP gains a tool only when structured discovery helps. The skill's fallback can cover discovery as well as apply. It serves the one-source-of-truth goal of #354, because each behavior has one reference surface. | The CLI must gain read-only discovery commands to serve agents without MCP, which adds a public surface. Existing MCP users see no immediate change, so the benefit comes from what Calavera does not build, not from what it removes.                                                                                                                                                              |

## Decision

### 1. The CLI is the reference surface

Every new capability that changes a project, or that reports on a project's Calavera state, exists as a CLI command first. The contributor designs and tests it as a CLI command and a core function before considering an MCP or WebMCP tool. The lifecycle commands, `update`, `clean`, `doctor`, the `artifacts` commands, and `eject` once #678 ships it (ADR-0017), stay CLI-only unless a later issue shows that a structured tool adds something a `--json` flag does not. Artifact status is the one exception this ADR names, in Decision 3.

`inspect_project` is the one existing capability that breaks this rule: it reports on a project and has no CLI command. Open question 1 covers it.

### 2. One application core, called in the same process

The CLI, the MCP server, and the Composer are adapters over one core: `recipe.js` for the catalog, composition, validation, and explanation; `baseline-core` for Baseline; and `inspectProject` and `applyRecipeObject` in `index.js` for inspection and the apply pipeline. An adapter translates its transport's input into a core call and the core's result into its transport's output, and it holds no catalog, validation, composition, or explanation logic of its own. MCP does not run the CLI as a child process, because an in-process call keeps structured results and the error cause chain that `toolErrorResult` reports.

The input schema of a tool that MCP and WebMCP share comes from one definition in the core. Where only Node.js can serve part of a tool, such as the artifact `inputs` of `compose_recipe`, the core definition marks that part as Node.js-only, and the WebMCP adapter leaves it out. The schema stays one definition, so the surfaces cannot drift apart unnoticed.

### 3. The MCP server is for discovery, explanation, composition, and the two-step apply

The MCP server keeps its twelve discovery, composition, and explanation tools, because structured, enumerated choices are where tool calls help most: an agent learns valid IDs from `list_integrations` instead of guessing a flag value. It keeps `dry_run_apply` and `apply_recipe` with their current names and inputs, because C8 names `dry_run_apply` as the approval boundary and existing registrations rely on both.

The owner adds a new mutating MCP tool only through its own decision issue. Whether `apply_recipe` stays long term is deferred to open question 4. A read-only MCP tool that reports project state may be added as an adapter over the same core function as its CLI command. The first such tool is artifact status. The brief's task CAL-041, which ships `artifacts status`, asks for artifact status "from the CLI and MCP"; #398 delivered the CLI command, and no MCP tool reports it yet. The tool lets an agent in the MCP flow see that an artifact has an update before it composes or applies, without leaving the tool sequence for a shell command.

### 4. WebMCP is the browser-constrained composition surface

WebMCP offers the MCP server's discovery, Baseline, composition, validation, and explanation tools under the same names and response shapes, with these intentional differences:

| Difference                                                                                                                                                                                                   | Why                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| No `inspect_project`, `dry_run_apply`, or `apply_recipe`.                                                                                                                                                    | A web page cannot read or write the person's project.                              |
| Adds `download_recipe`.                                                                                                                                                                                      | Saving the recipe is how a composition leaves the browser.                         |
| `compose_recipe` neither accepts artifact `inputs` nor reports artifact inputs, integration inputs, or the Vite+ result, and its description does not promise them. `explain_recipe` omits the Vite+ result. | These need Node.js, Git, or the project directory, which the browser cannot reach. |
| Results are checked against the latest published CLI version.                                                                                                                                                | The hosted page may be newer than the CLI that will apply the recipe.              |

The unintended differences listed in "Where the two tool surfaces differ under one name" are gaps, and follow-up 1 closes them. Any difference that this table does not list and that follow-up 1 does not close needs its own decision issue.

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

The release notes name the replacement for every group. The last row needs a rule that this ADR does not settle, and open question 3 covers it.

### 7. Follow-up work waits for acceptance

The owner creates implementation issues after accepting this ADR. Consequences lists the proposed follow-ups.

### 8. How C8 holds

- **Only the CLI writes into projects.** This ADR adds no writer. `apply_recipe` was part of the MCP server when the brief recorded C8 (brief Section 2 lists it), and it runs `applyRecipeObject` in the CLI package. WebMCP writes nothing in a project; `download_recipe` saves a file through the browser.
- **`dry_run_apply` is the approval boundary.** This is unchanged. Decision 3 keeps both tools, and no new mutating tool arrives without a decision issue.
- **Local edits are preserved.** This is unchanged, because every write still goes through the existing pipeline.
- **Artifacts are not recorded in `package.json`.** This is unchanged, for the same reason.
- **Conflicts surface as a hard stop or a migration decision.** This is unchanged, for the same reason.

## Consequences

The proposed follow-up issues, for the owner to create after acceptance:

1. Move the input schema of each shared tool into the core, with Node.js-only parts marked, generate the Zod and JSON Schema forms from it, and add a test that MCP and WebMCP accept the same inputs for each shared tool name. This closes the unintended differences, starting with the repeated CodeQL language list.
2. Depending on open question 1: add read-only CLI commands with `--json` output for discovery and project inspection that call the same core functions as the MCP tools, with a test that the JSON equals the MCP `structuredContent` for the same input.
3. Depending on open question 2: extend the bundled skill's fallback so that an agent without MCP discovers through the CLI as well as applying through it.
4. Add a read-only MCP tool for artifact status over the core function behind `artifacts status`, to finish CAL-041.

Existing MCP users see no change. The cost is that new lifecycle capabilities reach MCP users only through the CLI, which their agents can already run.

## Alternatives considered

**Keep full parity and extend it to lifecycle commands.** This was rejected because it triples the design and test work for each command and adds mutating MCP tools whose approval boundary would need its own decision, without evidence that agents need them as tools rather than commands.

**Make MCP read-only and remove `apply_recipe`.** This was not chosen for this release. It would leave `dry_run_apply` as an approval boundary with nothing behind it in MCP, it would break existing users, and the removal rule requires its own ADR. Open question 4 keeps it open.

**Make MCP run the CLI as a child process.** This was rejected for the reasons in the comparison table: a process per call, lost error causes, and no benefit over an in-process call to the same core.

## Open questions

1. **Should the CLI gain read-only discovery and inspection commands?** The first option adds a small set with `--json`, for example listing and describing integrations, AI artifacts, and Baseline targets, and inspecting the project. The second option leaves discovery to MCP and the Composer. The recommendation is the first option, because the issue's premise is that agents work well through commands, and today an agent without MCP or a browser has no discovery path. The implementation issue chooses the command names and checks them against the existing `formatHelp` grammar.
2. **Should the bundled skill's fallback include CLI discovery?** The skill already falls back to the Composer for composition and to the CLI for `apply --dry-run` and `apply`. The first option keeps that fallback. The second option adds the CLI discovery commands, so an agent can learn the valid IDs without a browser and then compose with `init --yes`. The recommendation is the second option once open question 1 is answered with its first option, because it removes the browser step for agents in a terminal.
3. **How should the bundled skill handle an MCP server older than the skill?** The first option has the skill name a replacement tool only together with an instruction to update the pinned MCP version. The second option has the skill tell the agent to use only the tools the server lists, which it already asks the agent to confirm. The recommendation is the second option, because it needs no version coupling between two separately updated artifacts.
4. **Should `apply_recipe` remain an MCP tool long term?** The first option keeps it. The second option removes it in a later release and has agents run `create-project-calavera apply` after `dry_run_apply`. The recommendation is the first option, because it is the documented end of the MCP flow, it already runs the CLI's pipeline, and removing it buys little.
