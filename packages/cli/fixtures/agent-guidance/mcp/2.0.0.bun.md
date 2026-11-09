# Calavera MCP Setup

Register the Calavera MCP server from the project root:

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

If your agent exposes an MCP setup UI or config writer, use the snippet above.
If the agent needs approval before editing its own config, ask first.

Use the tools in this order:

1. `list_profiles`
2. `list_integrations`
3. `describe_integration`
4. `list_ai_artifacts`
5. `compose_recipe`
6. `validate_recipe`
7. `explain_recipe`
8. `dry_run_apply`
9. `apply_recipe`

`dry_run_apply` is the review boundary. Show its result to the user and wait for explicit approval before calling `apply_recipe`.

Before composing a recipe, inspect the project for existing tooling files such as `package.json`, `calavera.config.json`, `.editorconfig`, `eslint.config.js`, `oxlint.json`, `.prettierrc.json`, `.stylelintrc.json`, and `tsconfig.json`. Mention likely conflicts or local conventions before proposing changes. If conflicts exist, say whether they are hard stops or migration decisions, then use `dry_run_apply` to show the impact when adoption is still possible.

If the MCP server cannot be registered, use the hosted Web UI to compose and download a recipe:

https://calavera.schalkneethling.com

Then run `bunx create-project-calavera apply --dry-run` and ask for approval before running `bunx create-project-calavera apply`.

Suggested first prompt:

> Use Calavera for this project. Inspect the current project for existing tooling and possible config conflicts, then list the available profiles, integrations, and AI artifacts. Once the profile and requirements are clear, compose a recipe, show me the dry-run result, and apply it only after I approve.
