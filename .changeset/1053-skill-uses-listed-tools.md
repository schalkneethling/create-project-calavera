---
"@schalkneethling/calavera-skill-calavera": patch
"create-project-calavera": patch
---

The Calavera skill no longer lists a fixed set of MCP tools to look for. It now tells the agent to use only the Calavera tools that the MCP server lists, because the skill and the project's pinned server update separately, and a skill newer than the server may describe a tool that the server does not have. The skill also separates two cases that it used to treat the same. When the client lists no Calavera tools, the agent tells the user that the tools are unavailable, names both causes (the server is not registered, or the client does not allow the tools), and asks before registering or repairing anything. When the server lists Calavera tools but not one a step names, the agent tells the user which tool is missing and continues with the tools it lists; when that tool is `compose_recipe`, `dry_run_apply`, or `apply_recipe`, it applies nothing through MCP.

Before switching from the MCP tools to the CLI fallback, for any reason, the agent now asks the user and waits for agreement. When the user refuses a Calavera tool call at a permission prompt, the agent stops and asks, and never runs the CLI apply command in its place. The prompt the skill suggests no longer tells the agent to stop when a single tool is missing. The copy that `--init` installs changes the same way (#1053).
