---
"create-project-calavera": minor
"@schalkneethling/calavera-skill-calavera": patch
---

A catalog integration can now declare the lines it needs in a project's `.gitignore` and in the managed `.htmlvalidateignore`, in an `ignore` field of its catalog entry (ADR-0016). Apply writes an integration's `.gitignore` lines as a block between `# calavera:<id>:start` and `# calavera:<id>:end`, after your own lines, which stay exactly as they were and in the same order. Apply records the block in `.calavera/state.json` as `gitignoreBlocks`, replaces it only while it still holds what apply wrote, and removes it when the recipe no longer selects the integration. If you edited the block, the dry run and apply stop with a conflict that shows both texts, and nothing is written.

The dry run lists the lines each integration adds to or removes from both files, and `apply --json` and `dry_run_apply` return them as `ignoreChanges`. After apply, a second dry run reports both files as unchanged.

The html-validate integration now declares its own `.htmlvalidateignore` lines this way, so a recipe with html-validate writes the same file as before. No integration in this release declares `.gitignore` lines yet, and Varlock keeps its existing `.gitignore` merge.

The Calavera skill now tells the agent to show `ignoreChanges` to the user as part of the dry run.
