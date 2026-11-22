---
"create-project-calavera": patch
---

The MCP server's tools now accept every value Calavera already tolerated, instead of refusing it with an invalid-arguments error:

- `list_integrations` accepts any `profile`. A `profile` of `null`, `""`, `false`, or `0` lists every integration, as an omitted profile does, and the response reports `profile: null`. Any other value that is not a profile ID, such as `"DEFAULT"`, lists no integrations, and the response reports the profile as it was sent, so its output schema now declares `profile` as any value, with text or `null` first. The removed profile IDs `modern` and `classic` are still refused with a message that names the replacement, as ADR-0011 requires; Calavera now refuses them itself, so the refusal comes back in its `{"error": {...}}` tool result instead of the SDK's invalid-arguments error.
- `describe_integration` accepts an `id` that is not text and reads it as text, so `["stylelint"]` describes Stylelint. An `id` that names no integration, such as `5`, now comes back in Calavera's `{"error": {...}}` tool result, with the same message, `Unknown integration: 5.`, instead of the SDK's invalid-arguments error.
- `search_baseline_features` accepts an omitted or `null` `query`, a `query` that is not text, and any `limit`. A `limit` that is not a positive integer, such as `null` or `0`, uses the default of 20, and a `limit` above 100 is served in full.
- `compose_recipe` accepts a `tools` or `aiArtifacts` of `false`, `0`, or `""`, and reads it as absent, as it already read `null`.
- `validate_recipe` accepts any `recipe`, including a missing one, and reports one that is not an object in its `{ "ok": false, "errors": [...] }` result, instead of the SDK's invalid-arguments error.

A refused item inside `tools` or `aiArtifacts` still gets Calavera's own message, which names the item, such as `aiArtifacts[1].id`, but the error's location now names the list, such as `at aiArtifacts`, instead of the item.

The Composer's WebMCP tools declare the same schemas and now check each tool call against them before Calavera runs, so the browser keeps accepting every value it accepted before. It refuses only artifact `inputs` in `compose_recipe`, which Calavera records but the browser cannot check, and arguments that are not an object, which the WebMCP specification refuses before a tool runs. One answer changes because ADR-0011 requires it: `list_integrations` with the removed profile ID `modern` or `classic` now refuses with the message that names the replacement, where the Composer used to list no integrations (#1176).
