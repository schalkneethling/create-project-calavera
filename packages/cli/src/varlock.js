// @ts-check
// The note apply adds for a recipe with Varlock, in two forms (#1023). The `--json` and MCP
// results carry the full note, which names the files, so an agent reads it without the rest of
// the summary. The human summary names each file it lists once, under Files, so its form of the
// note points there for a file Files lists and names only the files Files does not list, such as
// an existing .env.schema that apply leaves alone, or both files on a second apply.
import { GITIGNORE_PATH } from "./ignore-lines.js";

export const VARLOCK_SCHEMA_PATH = ".env.schema";

const VARLOCK_RECOMMENDATION =
  "Varlock recommends committing non-local .env.* files while keeping .env.local and .env.*.local private.";

/** The note as `pointers` carries it. */
export const VARLOCK_POINTER = `Review ${VARLOCK_SCHEMA_PATH} and existing ${GITIGNORE_PATH} rules. ${VARLOCK_RECOMMENDATION}`;

/**
 * The note as the apply summary prints it, under Notes.
 *
 * @param {ReadonlySet<string>} listed The paths the summary names under Files.
 */
export function varlockSummaryPointer(listed) {
  const schemaListed = listed.has(VARLOCK_SCHEMA_PATH);
  const ignoreListed = listed.has(GITIGNORE_PATH);
  if (schemaListed && ignoreListed) {
    return `Review the Varlock schema and the ignore file listed under Files, including its existing rules. ${VARLOCK_RECOMMENDATION}`;
  }
  if (schemaListed) {
    return `Review the Varlock schema listed under Files and existing ${GITIGNORE_PATH} rules. ${VARLOCK_RECOMMENDATION}`;
  }
  if (ignoreListed) {
    return `Review ${VARLOCK_SCHEMA_PATH} and the ignore file listed under Files, including its existing rules. ${VARLOCK_RECOMMENDATION}`;
  }
  return VARLOCK_POINTER;
}
