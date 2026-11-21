---
"create-project-calavera": patch
---

The MCP server's `compose_recipe` tool now declares the shape of `integrationOptions` that Calavera accepts, instead of any object: the four option IDs, the fields of each, and their allowed values, such as the CodeQL languages of `github-repository-controls`. The declared shape refuses no input that Calavera accepted before, because Calavera already rejected every other value when it composed the recipe. The `integrationOptions` description now says that Stylelint Baseline requires `available` and accepts an optional `severity`. When Calavera refuses one of these values, the MCP error names the field and gives the same explanation as before. The MCP server and the Composer's WebMCP tools now take the input and output schemas of every tool they share from one definition, and a test fails when the two forms differ (#1051).
