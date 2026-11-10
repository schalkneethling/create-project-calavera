---
"@schalkneethling/calavera-skill-calavera": patch
---

The Calavera skill now tells the agent to confirm the test runner with the user when the recipe selects `stryker`, to offer the runners that `list_integrations` and `describe_integration` list in `testRunners`, and to record the choice in `integrationOptions.stryker.testRunner`, with `testFiles` for `node:test` only when the project's test paths differ from the `node --test` defaults (#890).
