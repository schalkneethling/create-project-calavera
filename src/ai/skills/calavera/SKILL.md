---
name: calavera
description: Compose, preview, and apply Calavera-managed JavaScript, TypeScript, CSS, and AI-tooling setup for existing or newly scaffolded projects. Use when the user asks to set up Calavera, choose tooling profiles or integrations, generate or apply calavera.config.json, install bundled skills/hooks/agents, inspect project-tooling options, run a Calavera dry run, or use the Calavera MCP server/Web UI workflow.
---

# Calavera

Use Calavera to compose and apply project tooling through its MCP tools whenever they are available. This skill guides the active agent; it is not a subagent by itself.

## Start Here

1. Confirm whether Calavera MCP tools are available. Look for tools named `inspect_project`, `list_profiles`, `list_integrations`, `list_ai_artifacts`, `compose_recipe`, `dry_run_apply`, and `apply_recipe`.
2. If the Calavera MCP tools are not available, stop and help the user register or repair the MCP server before composing or applying anything. Do not inspect npm cache internals or import Calavera source files from package cache paths as a substitute for MCP setup.
3. Call `inspect_project` when available, or inspect the project manually only when the MCP server cannot be registered and the user chooses a fallback flow. Check files such as `package.json`, `calavera.config.json`, `.editorconfig`, `eslint.config.js`, `oxlint.json`, `.prettierrc.json`, `.stylelintrc.json`, and `tsconfig.json`.
   If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use `dry_run_apply` to show concrete impact when adoption still looks possible.
4. Use AskUserTool or the agent client's equivalent when available to clarify profile preferences, framework needs, conflict decisions, and apply approval. If no such tool exists, ask the user directly.
5. List choices with `list_profiles`, `list_integrations`, and `list_ai_artifacts`. Use `describe_integration` when the user asks for more information or when you need to compare options.
6. Choose either Oxfmt or Prettier for formatting, never both.
7. Once the profile and requirements are clear, compose the recipe with `compose_recipe`.
8. Validate and explain it with `validate_recipe` and `explain_recipe`.
9. Present `dry_run_apply` output to the user before changing files, including inspection findings, omitted script explanations, ownership notes, and planned file changes.
10. Call `apply_recipe` only after the user explicitly approves the dry run.
11. If the MCP transport closes or reports `-32000` during or immediately after `apply_recipe`, treat the outcome as unknown instead of failed. Inspect `calavera.config.json`, `.calavera/state.json`, generated files, and package metadata before retrying the apply.

Do not hand-author `calavera.config.json` when the Calavera MCP server is available. Let Calavera compose, validate, dry-run, and apply the recipe so generated files, package scripts, dependencies, AI artifacts, and managed state stay consistent.

Treat files listed by `dry_run_apply` as Calavera-managed outputs. Do not hand-write or edit them; let `apply_recipe` or `create-project-calavera apply` create them after approval.

`apply_recipe.writeConfig: false` only skips writing `calavera.config.json`. Do not use it to bypass managed-file conflicts, stale state hashes, or an unapproved dry-run result.

## MCP Setup

If the Calavera MCP tools are not available, help the user register this server from the project root. Check the target project's `package.json` first and use the package manager declared by `packageManager` or `devEngines.packageManager`.

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

`npm create` needs `--` before Calavera flags, for example `npm create project-calavera -- --init`. Direct binary launchers such as `npx --package create-project-calavera create-project-calavera --help` do not need an extra `--` before Calavera flags. Avoid `npx --package create-project-calavera create-project-calavera -- --help`; MCP registrations launch `create-project-calavera-mcp` directly and should not add `--help`.

If a Bun-based MCP launch fails before Calavera starts with `error: bun is unable to write files to tempdir: PermissionDenied`, configure the MCP host to set `TMPDIR` to an absolute writable directory for that server. If Bun's package cache is also restricted, set `BUN_INSTALL_CACHE_DIR` to an absolute writable cache directory. Keep these overrides on Bun registrations only; they are recovery settings for restricted hosts, not default Calavera MCP config.

If this project was bootstrapped with `create-project-calavera --init`, also check `.agents/calavera/mcp.md` for local setup notes.

For Claude Code, prefer a project-scoped `.mcp.json` in the project root when the team should share the Calavera server registration. Do not put the server under `.claude/settings.json`; Claude Code does not load MCP servers from that file. You can also use `claude mcp add` to register the same package-manager-specific command.

Registering the Calavera MCP server is a persistent code-execution change that runs an external package, so ask for explicit user approval before creating `.mcp.json`, running `claude mcp add`, or approving the first server launch.

## Fallbacks

If the MCP server cannot be registered, use the hosted Calavera Web UI to compose and download a recipe:

https://calavera.schalkneethling.com

After a recipe exists, preview local changes with the package-manager-specific apply dry-run command, pinned to the same explicit package version used for MCP setup: `npm create project-calavera@<version> apply -- --dry-run` for npm, `pnpm dlx create-project-calavera@<version> apply --dry-run` for pnpm, `yarn dlx create-project-calavera@<version> apply --dry-run` for Yarn, or `bunx create-project-calavera@<version> apply --dry-run` for Bun. Ask the user to approve the preview before running the matching apply command.

## User Prompt

When the user wants to start from a scaffolded or existing project, suggest:

```text
Use Calavera for this project. First verify that the Calavera MCP tools are available. If they are not available, stop and help me configure the MCP server before composing or applying anything. Once the tools are available, inspect the current project for existing tooling and possible config conflicts, list the available profiles, integrations, and AI artifacts, compose a recipe, show me the dry-run result, and apply it only after I approve.
```
