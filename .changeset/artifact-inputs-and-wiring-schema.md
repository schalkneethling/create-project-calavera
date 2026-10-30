---
"create-project-calavera": minor
"@schalkneethling/calavera-artifact-core": minor
---

Skill artifacts can now declare inputs and wiring in `calavera-artifact.json` (ADR-0015, Decisions 4 and 6), and the artifact catalog carries them. An input such as `protectedBranch` has a prompt, an optional default, and a check. A recipe can record an answer on the artifact's entry, as in `{ "id": "skill-protected-branch-guard", "inputs": { "protectedBranch": "main" } }`, and `compose_recipe` accepts `inputs` on each AI artifact. Recipe validation refuses a value for an input the artifact does not declare. No artifact declares inputs or wiring yet, and apply does not read them yet; `skill-protected-branch-guard` will be the first artifact to use them.
