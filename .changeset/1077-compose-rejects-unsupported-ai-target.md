---
"create-project-calavera": patch
---

The MCP `compose_recipe` tool and `init --ai-artifact <id>@<target>` now reject a target the artifact does not support, such as `hook-block-dangerous-commands@windsurf`, with the same error that recipe validation gives. Before, composing accepted any single directory name as a target and returned a recipe that `validate_recipe` and `apply` then rejected (#1077).
