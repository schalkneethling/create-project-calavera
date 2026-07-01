---
name: calavera
description: Compose, preview, and apply Calavera-managed JavaScript, TypeScript, CSS, and AI-tooling setup for existing or newly scaffolded projects. Use when the user asks to set up Calavera, choose tooling profiles or integrations, generate or apply calavera.config.json, install bundled skills/hooks/agents, inspect project-tooling options, run a Calavera dry run, or use the Calavera MCP server/Web UI workflow.
---

# Calavera

Use Calavera to compose and apply project tooling through its MCP tools whenever they are available. This skill guides the active agent; it is not a subagent by itself.

## Start Here

1. Confirm whether Calavera MCP tools are available. Look for tools named `list_profiles`, `list_integrations`, `list_ai_artifacts`, `compose_recipe`, `dry_run_apply`, and `apply_recipe`.
2. Inspect the project for existing tooling and likely conflicts before composing a recipe. Check files such as `package.json`, `calavera.config.json`, `.editorconfig`, `eslint.config.js`, `oxlint.json`, `.prettierrc.json`, `.stylelintrc.json`, and `tsconfig.json`.
   If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use `dry_run_apply` to show concrete impact when adoption still looks possible.
3. Use AskUserTool or the agent client's equivalent when available to clarify profile preferences, framework needs, conflict decisions, and apply approval. If no such tool exists, ask the user directly.
4. List choices with `list_profiles`, `list_integrations`, and `list_ai_artifacts`. Use `describe_integration` when the user asks for more information or when you need to compare options.
5. Once the profile and requirements are clear, compose the recipe with `compose_recipe`.
6. Validate and explain it with `validate_recipe` and `explain_recipe`.
7. Present `dry_run_apply` output to the user before changing files.
8. Call `apply_recipe` only after the user explicitly approves the dry run.

Do not hand-author `calavera.config.json` when the Calavera MCP server is available. Let Calavera compose, validate, dry-run, and apply the recipe so generated files, package scripts, dependencies, AI artifacts, and managed state stay consistent.

## MCP Setup

If the Calavera MCP tools are not available, help the user register this server from the project root:

```json
{
  "mcpServers": {
    "calavera": {
      "command": "npx",
      "args": ["--package", "create-project-calavera", "create-project-calavera-mcp"]
    }
  }
}
```

If this project was bootstrapped with `create-project-calavera --init`, also check `.agents/calavera/mcp.md` for local setup notes.

## Fallbacks

If the MCP server cannot be registered, use the hosted Calavera Web UI to compose and download a recipe:

https://calavera.schalkneethling.com

After a recipe exists, preview local changes with `npm create project-calavera apply --dry-run`. Ask the user to approve the preview before running `npm create project-calavera apply`.

## User Prompt

When the user wants to start from a scaffolded or existing project, suggest:

```text
Use Calavera for this project. Inspect the current project for existing tooling and possible config conflicts, then list the available profiles, integrations, and AI artifacts. Once the profile and requirements are clear, compose a recipe, show me the dry-run result, and apply it only after I approve.
```
