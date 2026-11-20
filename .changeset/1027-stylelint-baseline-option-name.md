---
"create-project-calavera": patch
---

The `compose_recipe` input description for `integrationOptions` now names the Stylelint Baseline field `available` instead of `availability`, so an agent that follows it no longer gets an "Unknown integrationOptions.stylelint-baseline fields" error. The MCP server and the Composer's WebMCP tool share this description (#1027).
