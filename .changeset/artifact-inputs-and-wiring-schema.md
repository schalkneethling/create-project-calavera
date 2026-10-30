---
"create-project-calavera": minor
"@schalkneethling/calavera-artifact-core": minor
"@schalkneethling/calavera-skill-calavera": patch
---

Skill artifacts can now declare inputs and wiring in `calavera-artifact.json` (ADR-0015, Decisions 4 and 6). An input such as `protectedBranch` has a prompt, an optional default, and a check, and a recipe records the answer on the artifact's entry, as in `{ "id": "skill-protected-branch-guard", "inputs": { "protectedBranch": "main" } }`. An interactive `init` or `apply` asks for each declared input, with the current branch as the default. Any other run uses the default, reports it, and records it in `calavera.config.json`, and it stops and names the input when there is no default, such as on a detached HEAD. A branch name must pass `git check-ref-format --branch` unchanged and use only letters, digits, `.`, `_`, `-`, and `/`, because apply writes it into hook commands that a shell runs. `compose_recipe` reports each declared input with its default in `artifactInputs`, and the Calavera skill tells the agent to confirm the value with the user before `dry_run_apply`. No artifact declares inputs or wiring yet; `skill-protected-branch-guard` will be the first.
