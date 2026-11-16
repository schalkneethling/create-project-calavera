---
"@schalkneethling/calavera-skill-calavera": patch
"create-project-calavera": patch
---

The Calavera skill now tells the agent to look for all 14 MCP tools the server registers, including `describe_integration` and the four Baseline tools, `list_baseline_targets`, `describe_baseline_target`, `search_baseline_features`, and `recommend_baseline_target`. The copy that `--init` installs changes the same way, and a test fails when either copy or the README's tool-order list differs from the registered tools (#933).
