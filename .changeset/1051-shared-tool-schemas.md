---
"create-project-calavera": patch
---

The MCP server's `compose_recipe` tool now declares the shape of `integrationOptions` that Calavera accepts, instead of any object: the four option IDs, the fields of each, and their allowed values, such as the CodeQL languages of `github-repository-controls`. The declared shape refuses no input that Calavera accepted before, because Calavera already rejected every other value when it composed the recipe. The `integrationOptions` description now says that Stylelint Baseline requires `available` and accepts an optional `severity`.

Because the MCP server now checks these inputs against the declared schema before Calavera runs, a refused input comes back in the MCP SDK's invalid-arguments error, `MCP error -32602: Input validation error: Invalid arguments for tool <tool>: <message> at <field>`, instead of the `{"error": {...}}` JSON that Calavera returns for other tool errors. The message is still Calavera's own explanation, such as `Unknown integrationOptions: eslint.`, and the error names the field. This applies to every input of the tools the MCP server shares with the Composer that the schema refuses, including unknown keys and values of the wrong type.

The MCP server and the Composer's WebMCP tools now take the input and output schemas of every tool they share from one definition, and a test fails when the two forms differ (#1051).
