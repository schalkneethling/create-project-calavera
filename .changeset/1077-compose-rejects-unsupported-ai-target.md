---
"create-project-calavera": patch
---

The MCP `compose_recipe` tool now rejects a target the artifact does not support, such as `windsurf` for `hook-block-dangerous-commands`, with the same error that recipe validation gives. Before, composing accepted any single directory name as a target and returned a recipe that `validate_recipe` and `apply` then rejected. `init --ai-artifact <id>@<target>` already refused such a target before writing the recipe; it now refuses it before it asks for any artifact input values. Recipe validation now also checks an entry that omits its target against the artifact's supported targets, using the default target; every current artifact supports the default target, so no current recipe changes (#1077).
