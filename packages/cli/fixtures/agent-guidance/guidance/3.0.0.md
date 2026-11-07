<!-- calavera-agent-bootstrap -->
# Calavera Agent Guidance

- Use Calavera when the user wants to inspect, compose, preview, apply, or update project tooling.
- Verify the Calavera MCP tools are available before composing a recipe.
- Prefer the Calavera MCP server over hand-authoring `calavera.config.json`.
- If the Calavera MCP tools are not available, stop and help the user register the MCP server from `.agents/calavera/mcp.md`, then reload the agent session if the MCP host requires it.
- Do not inspect npm cache internals or import Calavera source files from a package cache as a substitute for MCP setup.
- Inspect existing project tooling before composing a recipe and raise likely config conflicts early.
- If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use `dry_run_apply` to show concrete impact when adoption still looks possible.
- Start with `inspect_project`, `list_profiles`, `list_integrations`, and `list_ai_artifacts`; use `describe_integration` when the user asks for more information or an option needs explanation.
- Compose recipes with `compose_recipe`, validate them with `validate_recipe`, and explain the selected integrations with `explain_recipe`.
- Always present `dry_run_apply` output to the user before changing files.
- Call `apply_recipe` only after the user explicitly approves the dry-run result.
- If the MCP transport closes or reports `-32000` during or immediately after `apply_recipe`, treat the outcome as unknown instead of failed. Inspect `calavera.config.json`, `.calavera/state.json`, generated files, and package metadata before retrying the apply.
- Treat files listed by `dry_run_apply` as Calavera-managed outputs. Do not hand-write or edit them; let `apply_recipe` or `create-project-calavera apply` create them after approval.
- Use AskUserTool or the agent client's equivalent when available for profile choices, conflict decisions, and apply approval.

MCP setup notes live in `.agents/calavera/mcp.md`.
