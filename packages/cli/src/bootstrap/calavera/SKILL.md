---
name: calavera
description: Compose, preview, and apply Calavera-managed JavaScript, TypeScript, CSS, and AI-tooling setup for existing or newly scaffolded projects. Use when the user asks to set up Calavera, choose tooling profiles or integrations, generate or apply calavera.config.json, install bundled skills/hooks/agents, inspect project-tooling options, run a Calavera dry run, or use the Calavera MCP server/Web UI workflow.
---

# Calavera

Use Calavera to compose and apply project tooling through its MCP tools whenever they are available. This skill guides the active agent; it is not a subagent by itself.

## Start Here

1. Check which Calavera tools the MCP server lists, and use only the Calavera tools the server lists. If the agent client lists no Calavera tools at all, the Calavera tools are unavailable for one of two reasons: the server is missing, because it is not registered, did not start, or the session has not reloaded since registration, or the client does not allow the tools, for example because of the user's permission rules. Tell the user that the Calavera tools are unavailable and name both causes, then stop and ask the user before you register or repair the server, as MCP Setup describes, and before composing or applying anything. Do not inspect npm cache internals or import Calavera source files from package cache paths as a substitute for MCP setup.
2. This skill and the project's pinned MCP server update separately, so a later step may name a tool that the pinned server does not have. Never call a tool the server does not list. When the server lists Calavera tools but not a tool that a step names, that is a missing tool, not a missing server, so the registration does not need repair: the pinned server may predate the tool, or the client may hide it. Tell the user which tool the server does not list, skip the part of the step that needs it, and continue with the tools the server lists. When `compose_recipe`, `dry_run_apply`, or `apply_recipe` is missing, apply nothing through MCP, because through MCP the user approves changes only from a `dry_run_apply` result. A server version newer than the pinned one may provide the tool, but changing the registration needs the user's approval, as MCP Setup describes.
3. Call `inspect_project` when the server lists it. Inspect the project manually only after the user agrees to switch to Fallbacks, for example because the MCP server cannot be registered or a missing approval tool stops the MCP flow, as step 2 describes. Check files such as `package.json`, `calavera.config.json`, `.editorconfig`, and `.stylelintrc.json`.
   If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use `dry_run_apply` to show concrete impact when adoption still looks possible.
4. Use AskUserTool or the agent client's equivalent when available to clarify profile preferences, framework needs, conflict decisions, and apply approval. If no such tool exists, ask the user directly.
5. List choices with `list_profiles`, `list_integrations`, and `list_ai_artifacts`. Use `describe_integration` when the user asks for more information or when you need to compare options.
6. Calavera does not scaffold a JavaScript or TypeScript formatter; in a `vp`-managed project, formatting comes from `vp fmt`.
7. Once the profile and requirements are clear, compose the recipe with `compose_recipe`.
   When the response lists `artifactInputs`, ask the user to confirm or change each value before `dry_run_apply`. Show the input's `prompt` and its `default`, and when `default` is null, its `defaultUnavailable` reason. Then compose again with the confirmed values in that artifact's `inputs`, so the recipe records them. Do the same for each entry in `integrationInputs`, such as `github-repository-controls.defaultBranch`, and pass the confirmed value in `integrationOptions`. Each default names its `defaultSource`; show it, so the user can tell whether it is the branch they mean.
   When the recipe selects `stylelint-baseline`, ask the user which Baseline target their CSS must meet before `dry_run_apply`. The Stylelint rule checks against `widely` by default, which needs no entry in the recipe. Show the targets that `list_baseline_targets` returns, or call `describe_baseline_target` when the user names a single target. When the user names CSS features they need, find their IDs with `search_baseline_features` and pass them to `recommend_baseline_target`, which returns the earliest fixed year that supports them all, or a null `recommendedTarget` with the `limitedFeatures` that are not yet Baseline. Compose again with any other target in `integrationOptions.stylelint-baseline.available`.
   When the recipe selects `stryker`, confirm the test runner with the user before `dry_run_apply`, because Calavera does not detect it from the project. Offer the runners that `list_integrations` or `describe_integration` list in `testRunners`; the first is the default and needs no entry in the recipe. When the user chooses another runner, compose again with it in `integrationOptions.stryker.testRunner`. For `node:test`, also ask which paths the project's test script passes to `node --test`, and record them as `integrationOptions.stryker.testFiles` only when they differ from the files that `node --test` runs by default.
8. Validate and explain it with `validate_recipe` and `explain_recipe`.
9. Present `dry_run_apply` output to the user before changing files, including inspection findings, omitted script explanations, ownership notes, and planned file changes. Show the user the command each `package.json` script in `scriptChanges` will run, and for a changed or renamed script the command it replaces.
   When `result.manifestDecision` has no `choice`, the current directory has no `package.json` of its own but Calavera found a manifest above it, so the dry run plans nothing. Show the user the ancestor manifest in `result.manifestDecision.ancestor.manifestPath`, whether Vite+ manages it in `result.manifestDecision.ancestor.status`, and every entry in `result.manifestDecision.options` with its `choice` and `description`: `create-here`, `apply-at-ancestor`, and `abandon`. Ask the user to choose, and never pick one for them, even when one looks obvious. Call `dry_run_apply` again with the user's choice as `manifestChoice`; the result records it in `result.manifestDecision.choice`, so do not ask again. For `abandon`, tell the user that Calavera changes nothing and stop. For the other choices, show the new dry run, and after the user approves it, pass the same `manifestChoice` to `apply_recipe`, which stops before writing anything without it. Pass `manifestChoice` only after a dry run returned `manifestDecision`, because Calavera refuses a choice where there is none to make.
10. Call `apply_recipe` only after the user explicitly approves the dry run. Pass it the recipe from the dry run's `result.recipe`, which records every artifact input and integration input; `apply_recipe` refuses an input the recipe does not record. Show the user each line in `wiringChanges`, each warning in `wiringWarnings` and `inputWarnings`, each value in `integrationInputs`, and each entry in `ignoreChanges`, which lists the lines apply adds to or removes from `.gitignore` and `.htmlvalidateignore`, and each entry in `stagingLeftovers`, which lists the old folders in `.calavera/.staging/` that apply removes and the entries there it keeps, as part of the dry run. After `dry_run_apply` and again after `apply_recipe`, show each entry in `temporaryFolderLeftovers` as a warning with its remedy: each is a temporary folder Calavera could not remove, which the user should remove; the command still finished.
11. If the MCP transport closes or reports `-32000` during or immediately after `apply_recipe`, treat the outcome as unknown instead of failed. Inspect `calavera.config.json`, `.calavera/state.json`, generated files, and package metadata before retrying the apply.

Do not hand-author `calavera.config.json` when the Calavera MCP server is available. Let Calavera compose, validate, dry-run, and apply the recipe so generated files, package scripts, dependencies, AI artifacts, and managed state stay consistent.

Before you switch from the MCP tools to the CLI in Fallbacks, for any reason, ask the user and wait for their agreement. This covers a tool the server lacks, a tool the client hides, every Calavera tool being unavailable, and a call the user refused at a permission prompt. A refused call is the user's answer, not a missing tool: in some clients the tool stays listed after the user refuses it, so step 2 does not apply. When the user refuses a Calavera tool call at a permission prompt, stop and ask the user how to continue, and never run the CLI apply command in its place.

Treat files listed by `dry_run_apply` as Calavera-managed outputs. Do not hand-write or edit them. Let `apply_recipe` create them after the user approves the dry run. In Fallbacks that the user agreed to, `create-project-calavera apply` creates them after the user approves its preview.

`apply_recipe.writeConfig: false` only skips writing `calavera.config.json`. Do not use it to bypass managed-file conflicts, stale state hashes, or an unapproved dry-run result.

Use `reownManagedFiles` only after the user explicitly approves losing their local edits to the listed Calavera-tracked files: `apply_recipe` replaces each listed file's current contents with Calavera's, so the edits are lost unless they save a copy first. Tell the user this before they approve, and never use it to keep an edit.

When the user asks to stop Calavera managing the project and keep the tooling it installed, that is the CLI command `eject`, not an MCP tool, because it removes the Calavera MCP registration. Ask the user to run the dry run, pinned to a release that has `eject`, such as `latest`, because the version pinned for MCP setup may predate it: `npm create project-calavera@latest eject -- --dry-run` for npm, `pnpm dlx create-project-calavera@latest eject --dry-run` for pnpm, `yarn dlx create-project-calavera@latest eject --dry-run` for Yarn, or `bunx create-project-calavera@latest eject --dry-run` for Bun, and then the same command without `--dry-run` in their own terminal, where they approve the list it shows. Do not delete Calavera's files by hand or run `eject --yes` for them.

## MCP Setup

If the Calavera MCP server is missing, help the user register this server from the project root. Check the target project's `package.json` first and use the package manager declared by `packageManager` or `devEngines.packageManager`.

```json
{
  "mcpServers": {
    "calavera": {
      "command": "npx",
      "args": ["--package", "create-project-calavera@<version>", "create-project-calavera-mcp"]
    }
  }
}
```

For manual MCP setup, use `npx --package create-project-calavera@<version> create-project-calavera-mcp` for npm-managed projects, `pnpm dlx --package create-project-calavera@<version> create-project-calavera-mcp` for pnpm, `yarn dlx --package create-project-calavera@<version> create-project-calavera-mcp` for Yarn, and `bunx --package create-project-calavera@<version> create-project-calavera-mcp` for Bun. In JSON-based MCP configs, put the first word in `command` and the remaining words in `args`. Matching the project package manager prevents package-manager preflight failures before Calavera can start, such as npm rejecting a Bun-managed project. Keep an explicit version so package-manager launchers resolve the `create-project-calavera-mcp` bin reliably without making the persistent MCP registration float to a later package release.

After registering the MCP server, reload or restart the agent session if the MCP host does not discover new tools dynamically. Confirm the Calavera tools are visible before composing a recipe.

`npm create` needs `--` before Calavera flags, for example `npm create project-calavera -- --init`. Direct binary launchers such as `npx --package create-project-calavera@<version> create-project-calavera --help` do not need an extra `--` before Calavera flags. Avoid `npx --package create-project-calavera@<version> create-project-calavera -- --help`; MCP registrations launch `create-project-calavera-mcp` directly and should not add `--help`.

If a Bun-based MCP launch fails before Calavera starts with `error: bun is unable to write files to tempdir: PermissionDenied`, configure the MCP host to set `TMPDIR` to an absolute writable directory for that server. If Bun's package cache is also restricted, set `BUN_INSTALL_CACHE_DIR` to an absolute writable cache directory. Keep these overrides on Bun registrations only; they are recovery settings for restricted hosts, not default Calavera MCP config.

If this project was bootstrapped with `create-project-calavera --init`, also check `.agents/calavera/mcp.md` for local setup notes.

For Claude Code, prefer a project-scoped `.mcp.json` in the project root when the team should share the Calavera server registration. Do not put the server under `.claude/settings.json`; Claude Code does not load MCP servers from that file. You can also use `claude mcp add` to register the same package-manager-specific command.

Registering the Calavera MCP server is a persistent code-execution change that runs an external package, so ask for explicit user approval before creating `.mcp.json`, running `claude mcp add`, or approving the first server launch.

## Fallbacks

Use this flow only after the user agrees to switch from the MCP tools to the CLI, for example when the MCP server cannot be registered, or when `compose_recipe`, `dry_run_apply`, or `apply_recipe` is missing. Compose and download a recipe in the hosted Calavera Web UI:

https://calavera.schalkneethling.com

After a recipe exists, preview local changes with the package-manager-specific apply dry-run command, pinned to the same explicit package version used for MCP setup: `npm create project-calavera@<version> apply -- --dry-run` for npm, `pnpm dlx create-project-calavera@<version> apply --dry-run` for pnpm, `yarn dlx create-project-calavera@<version> apply --dry-run` for Yarn, or `bunx create-project-calavera@<version> apply --dry-run` for Bun. Ask the user to approve the preview before running the matching apply command.

## User Prompt

When the user wants to start from a scaffolded or existing project, suggest:

```text
Use Calavera for this project. First check which Calavera MCP tools are available, and use only those. If none are available, stop and help me configure the MCP server before composing or applying anything. If a tool you need is missing, tell me which one, and do not apply anything without a dry run I approve. Once the tools are available, inspect the current project for existing tooling and possible config conflicts, list the available profiles, integrations, and AI artifacts, compose a recipe, show me the dry-run result, and apply it only after I approve.
```
