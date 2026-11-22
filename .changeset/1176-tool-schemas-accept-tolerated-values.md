---
"create-project-calavera": patch
---

The MCP server's tools now accept every value Calavera already tolerated, instead of refusing it with an invalid-arguments error:

- `list_integrations` accepts a `profile` of `null`, `""`, `false`, or `0`, and lists every integration, as an omitted profile does.
- `search_baseline_features` accepts an omitted or `null` `query`, a `query` that is not text, and any `limit`. A `limit` that is not a positive integer, such as `null` or `0`, uses the default of 20, and a `limit` above 100 is served in full.
- `compose_recipe` accepts a `tools` or `aiArtifacts` of `false`, `0`, or `""`, and reads it as absent, as it already read `null`.
- `validate_recipe` accepts any `recipe`, including a missing one, and reports one that is not an object in its `{ "ok": false, "errors": [...] }` result, instead of the SDK's invalid-arguments error.

The Composer's WebMCP tools declare the same schemas and now check each tool call against them before Calavera runs, so the browser refuses artifact `inputs` in `compose_recipe` and keeps accepting these values (#1176).
