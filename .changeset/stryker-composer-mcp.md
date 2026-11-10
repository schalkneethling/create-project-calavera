---
"create-project-calavera": minor
---

The integration listings now carry `notes`, the conditions to tell a user before they select an integration, read from the catalog entry. `list_integrations`, `describe_integration`, and `explain_recipe` repeat them in their text, and the Composer shows them under the integration's group heading. For `stryker`, the notes say that it needs a project that Vite+ manages, that it adds a `test:mutation` script that `quality` does not run, and that it applies in a single-package project or a workspace member, not at a workspace root (#735). The hosted Composer already hides `stryker` from a CLI older than 6.2.0, and a test now pins that.
