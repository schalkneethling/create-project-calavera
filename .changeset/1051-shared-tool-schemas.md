---
"create-project-calavera": patch
---

The MCP server's `compose_recipe` tool now declares the shape of `integrationOptions` that Calavera accepts, instead of any object: the four option IDs, the fields of each, and their allowed values, such as the CodeQL languages of `github-repository-controls`. The declared shape refuses no input that Calavera accepted before, because Calavera already rejected every other value when it composed the recipe. The `integrationOptions` description now says that Stylelint Baseline requires `available` and accepts an optional `severity`.

A value inside `integrationOptions` that Calavera refuses now comes back in the MCP SDK's invalid-arguments error, `MCP error -32602: Input validation error: Invalid arguments for tool <tool>: <message> at <path>`, instead of the `{"error": {...}}` JSON that Calavera returns for other tool errors, because the server checks it against the declared schema before Calavera runs. The message is still Calavera's own, such as `Unknown integrationOptions: eslint.`, and it names the field. Inputs that the SDK error already refused, such as an unknown `packageManager`, keep that error but now carry Calavera's message instead of the schema library's. This covers unknown keys and values of the wrong type in every tool the MCP server shares with the Composer. A `describe_integration` ID that is not a string still gets the schema library's message, as it did before this change, because Calavera converts such an ID to text instead of refusing it.

`compose_recipe` now also accepts `null` for `tools` and `aiArtifacts`, and `describe_baseline_target` accepts a year written as a string, such as `"2024"`, because Calavera already read those values.

The MCP server and the Composer's WebMCP tools now take the input and output schemas of every tool they share from one definition, and a test fails when the two forms differ (#1051).
