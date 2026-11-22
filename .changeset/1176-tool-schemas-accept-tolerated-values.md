---
"create-project-calavera": patch
---

The MCP server's tools now accept every value Calavera already tolerated, instead of refusing it with an invalid-arguments error:

- `list_integrations` accepts a `profile` of `null`, `""`, `false`, or `0`, lists every integration, as an omitted profile does, and reports `profile: null` in its response.
- `search_baseline_features` accepts an omitted or `null` `query`, a `query` that is not text, and any `limit`. A `limit` that is not a positive integer, such as `null` or `0`, uses the default of 20, and a `limit` above 100 is served in full.
- `compose_recipe` accepts a `tools` or `aiArtifacts` of `false`, `0`, or `""`, and reads it as absent, as it already read `null`.
- `validate_recipe` accepts any `recipe`, including a missing one, and reports one that is not an object in its `{ "ok": false, "errors": [...] }` result, instead of the SDK's invalid-arguments error.

A refused item inside `tools` or `aiArtifacts` still gets Calavera's own message, which names the item, such as `aiArtifacts[1].id`, but the error's location now names the list, such as `at aiArtifacts`, instead of the item.

The Composer's WebMCP tools declare the same schemas and now check each tool call against them before Calavera runs, so the browser keeps accepting these values. It now refuses what the declared schemas refuse: artifact `inputs` in `compose_recipe`, an unknown `list_integrations` profile, for which it used to list no integrations, a `describe_integration` ID that is not a string, and arguments that are not an object (#1176).
