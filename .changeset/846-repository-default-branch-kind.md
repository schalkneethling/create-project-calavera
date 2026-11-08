---
"@schalkneethling/calavera-artifact-core": minor
"@schalkneethling/calavera-skill-protected-branch-guard": patch
---

The input default kind `current-branch` is replaced by `repository-default-branch` in the artifact schema, in the artifact catalog's `ArtifactInput` type, and in the protected branch guard's `calavera-artifact.json` (#846). The new name says what Calavera suggests: the repository's default branch, never the current branch. A manifest that declares `current-branch` no longer validates against the artifact schema. The schema version stays 1. A Calavera release that predates this change reads the guard's input from its own bundled catalog, not from the installed manifest, so it keeps working with this artifact.
