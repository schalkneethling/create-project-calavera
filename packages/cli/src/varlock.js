// @ts-check
// The note apply adds for a recipe with Varlock, in two forms (#1023). The `--json` and MCP
// results carry the full note, which names the files, so an agent reads it without the rest of
// the summary. The human summary already names both files under Files, so it prints a form that
// points there instead of naming them a second time.

/** The note as `pointers` carries it. */
export const VARLOCK_POINTER =
  "Review .env.schema and existing .gitignore rules. Varlock recommends committing non-local .env.* files while keeping .env.local and .env.*.local private.";

/** The note as the apply summary prints it, under Notes. */
export const VARLOCK_SUMMARY_POINTER =
  "Review the Varlock schema and the ignore file listed under Files, including its existing rules. Varlock recommends committing non-local .env.* files while keeping .env.local and .env.*.local private.";
