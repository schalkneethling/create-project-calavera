---
"create-project-calavera": minor
"@schalkneethling/calavera-artifact-core": minor
---

The catalogs now carry the display labels that the Composer shows. `@schalkneethling/calavera-artifact-core` exports `ARTIFACT_TARGET_LABELS`, which maps each artifact target ID to the tool's own name, such as `claude-code` to "Claude Code". In `create-project-calavera`, each integration from `list_integrations` and `describe_integration` has a `statusLabel`, such as "Recommended" or "Framework-specific", which the MCP output schema declares, and each artifact from `list_ai_artifacts`, and from the `aiArtifacts` of `explain_recipe`, has `targets`, a list of `{ id, label }` objects that is empty for skills. The `compose_recipe` input description now says that an artifact's `target` is one of those IDs, not a directory. Recipe output does not change (#580).
