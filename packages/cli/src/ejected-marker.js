// @ts-check
import { readFile } from "node:fs/promises";

import { GITIGNORE_PATH } from "./ignore-lines.js";
import { findBlock } from "./utils/marked-block.js";

/**
 * The owner ID of the block `eject` leaves at the end of `.gitignore` once it has removed
 * Calavera's records (ADR-0017, Amendment 5). It is neither an artifact nor an integration ID, as
 * `artifact-cache` is neither, so a test keeps every catalog ID different from it.
 */
export const EJECTED_BLOCK = "ejected";

/**
 * The block's one line, fixed text. It is a comment, so Git ignores no path because of it. A block
 * with paired markers and any other contents is an edited block (ADR-0017, Amendment 5).
 */
export const EJECTED_LINE =
  "# create-project-calavera eject removed Calavera's records from this project.";

/**
 * What `.gitignore` holds of the `ejected` block. `complete` and `edited` both have paired
 * markers, so ADR-0020 reads both as the marker; `edited` holds anything other than the fixed
 * line. `broken` has an unpaired, repeated, out-of-order, or changed marker, so it counts as no
 * marker for the phase, and ADR-0017, Amendment 5 has `apply` and `eject` stop on it.
 * `unreadable` is a `.gitignore` that exists and cannot be read, such as a folder; it counts as
 * no marker, and `code` names the error's code, or is null when the error has none. A reason in
 * ADR-0020's sense never quotes a line from the file, so none is kept here.
 *
 * @typedef {{ status: "absent" | "complete" | "edited" | "broken" } | { status: "unreadable", code: string | null }} EjectedMarker
 */

/**
 * Reads the `ejected` block from the `.gitignore` of the current folder, the one `eject` writes it
 * into, without writing anything.
 *
 * @returns {Promise<EjectedMarker>}
 */
export async function readEjectedMarker() {
  let contents;
  try {
    contents = await readFile(GITIGNORE_PATH, "utf8");
  } catch (error) {
    const { code } = /** @type {NodeJS.ErrnoException} */ (error);
    if (code === "ENOENT") return { status: "absent" };
    return { status: "unreadable", code: code ?? null };
  }
  const block = findBlock(GITIGNORE_PATH, contents, EJECTED_BLOCK);
  // findBlock's reason quotes a changed marker line, which is the person's text, so only the
  // fact that the markers cannot be trusted is kept.
  if ("reason" in block) return { status: "broken" };
  if (block.startIndex === -1) return { status: "absent" };
  return { status: block.current === EJECTED_LINE ? "complete" : "edited" };
}
