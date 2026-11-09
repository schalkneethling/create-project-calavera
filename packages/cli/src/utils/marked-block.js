// @ts-check

// A block of lines that Calavera owns inside a file the project owns, between a start and an end
// marker that name the block's owner: an artifact in a .vite-hooks script (ADR-0015, Decision 5),
// or an integration in .gitignore (ADR-0016). Both files take `#` comments, so the markers are the
// same in each. Apply never touches a line outside a block.

/**
 * @param {string} owner The artifact or integration id the block belongs to.
 */
export function markers(owner) {
  return {
    start: `# calavera:${owner}:start`,
    end: `# calavera:${owner}:end`,
  };
}

/**
 * @typedef {object} FoundBlock
 * @property {string[]} lines The file's lines, each with its own carriage return, if any.
 * @property {string} cr "\r" when the file uses Windows line endings, so added lines match.
 * @property {number} startIndex The start marker's line, or -1 when the file has no block.
 * @property {number} endIndex The end marker's line, or -1 when the file has no block.
 * @property {string} current The text between the markers, without carriage returns.
 */

/**
 * Finds the owner's block in a file, or explains why its markers cannot be trusted.
 *
 * @param {string} path
 * @param {string} contents
 * @param {string} owner
 * @returns {FoundBlock | { reason: string }}
 */
export function findBlock(path, contents, owner) {
  const { start, end } = markers(owner);
  // Lines keep their own endings. A file with Windows line endings gets them on the lines
  // Calavera adds too, and every comparison ignores the carriage return.
  const cr = contents.includes("\r\n") ? "\r" : "";
  const lines = contents.split("\n");
  const bare = lines.map((text) => text.replace(/\r$/, ""));
  const indexes = (/** @type {string} */ marker) =>
    bare.flatMap((text, index) => (text.trimEnd() === marker ? [index] : []));
  const starts = indexes(start);
  const ends = indexes(end);

  // A line that names this block but is not exactly a marker is one the person changed, such as
  // an indented block inside an `if`. Inserting a second block would defeat their change.
  const changedMarker = bare.find(
    (text) =>
      (text.includes(`calavera:${owner}:start`) || text.includes(`calavera:${owner}:end`)) &&
      text.trimEnd() !== start &&
      text.trimEnd() !== end,
  );
  if (changedMarker !== undefined) {
    return {
      reason: `${path}: a marker line was changed: "${changedMarker}". Calavera only recognizes "${start}" and "${end}" as whole lines. Restore them, or remove the block, both markers included, and run apply again.`,
    };
  }

  if (starts.length === 0 && ends.length === 0) {
    return { lines, cr, startIndex: -1, endIndex: -1, current: "" };
  }

  const markerProblem =
    starts.length === 1 && ends.length === 0
      ? "has a start marker without an end marker"
      : starts.length === 0 && ends.length === 1
        ? "has an end marker without a start marker"
        : starts.length !== 1 || ends.length !== 1
          ? `has ${starts.length} start marker${starts.length === 1 ? "" : "s"} and ${ends.length} end marker${ends.length === 1 ? "" : "s"}`
          : /** @type {number} */ (ends[0]) < /** @type {number} */ (starts[0])
            ? "has an end marker that comes before its start marker"
            : undefined;
  if (markerProblem !== undefined) {
    return {
      reason: `${path}: the Calavera block for ${owner} ${markerProblem}, so Calavera cannot tell where its block ends. Make the file hold exactly one "${start}" line followed later by one "${end}" line, or remove both markers and the lines between them, and run apply again.`,
    };
  }

  const startIndex = /** @type {number} */ (starts[0]);
  const endIndex = /** @type {number} */ (ends[0]);
  return {
    lines,
    cr,
    startIndex,
    endIndex,
    current: bare.slice(startIndex + 1, endIndex).join("\n"),
  };
}

/**
 * Indents each line of a block's text, for a conflict message that shows it.
 *
 * @param {string} text
 */
export function indent(text) {
  return text
    .split("\n")
    .map((row) => `  ${row}`)
    .join("\n");
}
