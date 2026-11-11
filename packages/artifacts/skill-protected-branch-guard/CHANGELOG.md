# @schalkneethling/calavera-skill-protected-branch-guard

## 0.1.1

### Patch Changes

- 23b1b46: The input default kind `current-branch` is replaced by `repository-default-branch` in the artifact schema, in the artifact catalog's `ArtifactInput` type, and in the protected branch guard's `calavera-artifact.json` (#846). The new name says what Calavera suggests: the repository's default branch, which is not read from the current branch. A manifest that declares `current-branch` no longer validates against the artifact schema. The schema version stays 1. A Calavera release that predates this change reads the guard's input from its own bundled catalog, not from the installed manifest, so it keeps working with this artifact.

## 0.1.0

### Minor Changes

- 873e517: Add `skill-protected-branch-guard`, which refuses a commit, a push, or a Claude Code file edit on the branch you protect (ADR-0015). Apply installs the skill and wires it into the project: a marked block in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and hook groups in the committed `.claude/settings.json`. The dry run shows every line and group first, and apply stops with a conflict, writing nothing, when you have edited its part.

  Calavera asks for the protected branch, with the current branch as the default, and records it in the recipe. `compose_recipe` reports the input and its default, `dry_run_apply` returns the recipe with the value filled in, and `apply_recipe` refuses a recipe that does not record it, so the branch cannot change between approval and apply. When Git would not run the hooks, because the Vite+ hook dispatcher is not installed or hooks are turned off in the clone, apply warns and names the command that fixes it.

  A rewritten `.claude/settings.json` is formatted before the dry run with the project's own `vp fmt`, so it already passes `vp check` with the project's formatter settings.
