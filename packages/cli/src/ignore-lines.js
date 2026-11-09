// @ts-check

// ADR-0016: an integration declares the lines it needs in `.gitignore` and in the managed
// `.htmlvalidateignore` in the `ignore` field of its catalog entry. Apply writes the `.gitignore`
// lines as one marked block per integration and never touches a line outside a block. The
// `.htmlvalidateignore` lines go into the managed file, which apply already writes as a whole.

import { findBlock, indent, markers } from "./utils/marked-block.js";

export const GITIGNORE_PATH = ".gitignore";
export const HTML_VALIDATE_IGNORE_PATH = ".htmlvalidateignore";

/**
 * @typedef {"gitignore" | "htmlValidateIgnore"} IgnoreFile
 *
 * @typedef {object} IgnoreLines One integration's lines for one ignore file. The state record keeps
 *   the `.gitignore` ones as `gitignoreBlocks`, so a later apply can tell its block from an edit.
 * @property {string} integration
 * @property {string[]} lines
 *
 * @typedef {object} IgnoreChange One integration's part of an ignore file, for the dry run.
 * @property {string} path
 * @property {string} [integration] Absent when `.htmlvalidateignore` loses lines no selected integration declares.
 * @property {"write" | "update" | "unchanged"} type
 * @property {string[]} [lines] The lines the integration's part holds after apply.
 * @property {string[]} [previousLines] The lines a replaced block held, or the lines `.htmlvalidateignore`
 *   holds where apply puts the integration's lines, when the file holds them in another order.
 * @property {string[]} [removedLines] The lines apply removes.
 */

/**
 * Returns why `line` may not go into an ignore file, or undefined when it may.
 *
 * @param {string} line
 * @returns {string | undefined}
 */
export function ignoreLineProblem(line) {
  if (/[\r\n]/.test(line)) {
    return `${JSON.stringify(line)} contains a line break, and each entry must be one line`;
  }
  if (line.trim() === "") {
    return "an entry is empty";
  }
  // findBlock treats any line that names a block as a marker, so a line like this would make
  // Calavera's own block look changed.
  if (/calavera:\S*:(?:start|end)/.test(line)) {
    return `${JSON.stringify(line)} looks like a Calavera block marker, which only Calavera writes`;
  }
  return undefined;
}

/**
 * The lines each integration declares for one ignore file, in catalog order.
 *
 * @param {{ id: string, ignore?: Partial<Record<IgnoreFile, string[]>> }[]} integrations
 * @param {IgnoreFile} file
 * @returns {IgnoreLines[]}
 */
export function declaredIgnoreLines(integrations, file) {
  return integrations.flatMap(({ id, ignore }) => {
    const lines = ignore?.[file] ?? [];
    return lines.length > 0 ? [{ integration: id, lines }] : [];
  });
}

/**
 * @param {string} integration
 * @param {string[]} lines
 * @param {string} cr
 */
function blockText(integration, lines, cr) {
  const { start, end } = markers(integration);
  return [start, ...lines, end].map((text) => `${text}${cr}\n`).join("");
}

/**
 * Plans the integrations' blocks in `.gitignore`. A recorded block whose integration no longer
 * declares lines is removed while it still holds the recorded lines. A declared block is appended
 * when it is missing, kept when it holds the declared lines, and replaced when it holds the
 * recorded lines. Any other block text, and a broken marker pair, is a conflict, and the planner
 * throws before anything is written.
 *
 * @param {object} options
 * @param {string | undefined} options.contents The file now, or undefined when it does not exist.
 * @param {IgnoreLines[]} options.declared The selected integrations' lines, in catalog order.
 * @param {IgnoreLines[]} options.records The blocks apply wrote last, from the state record.
 * @returns {{ contents: string | undefined, type: "write" | "update" | "unchanged" | undefined, changes: IgnoreChange[], records: IgnoreLines[] }}
 *   `type` is undefined when the plan touches no block, so apply reports nothing for the file.
 */
export function planGitignoreBlocks({ contents, declared, records }) {
  for (const { integration, lines } of declared) {
    for (const line of lines) {
      const problem = ignoreLineProblem(line);
      if (problem !== undefined) {
        throw new Error(
          `${integration} declares a ${GITIGNORE_PATH} line that Calavera refuses: ${problem}.`,
        );
      }
    }
  }

  /** @type {string[]} */
  const conflicts = [];
  /** @type {IgnoreChange[]} */
  const changes = [];
  /** @type {IgnoreLines[]} */
  const nextRecords = [];
  let text = contents;
  const declaredIds = new Set(declared.map(({ integration }) => integration));

  for (const record of records) {
    if (declaredIds.has(record.integration) || text === undefined) continue;
    const found = findBlock(GITIGNORE_PATH, text, record.integration);
    if ("reason" in found) {
      conflicts.push(found.reason);
      continue;
    }
    // The person already removed the block, so there is nothing left to remove.
    if (found.startIndex === -1) continue;
    const recorded = record.lines.join("\n");
    if (found.current !== recorded) {
      conflicts.push(
        `${GITIGNORE_PATH}: ${record.integration} no longer adds lines to ${GITIGNORE_PATH}, so Calavera would remove its block, but the block was edited since Calavera wrote it.\nCalavera wrote:\n${indent(recorded)}\nThe file now holds:\n${indent(found.current)}\nRemove the block yourself, both markers included, or keep the lines and delete the markers, and run apply again.`,
      );
      continue;
    }
    const after = found.lines.slice(found.endIndex + 1);
    // When the end marker is the file's last line and has no line break, the line before the block
    // still owns the line break that separated the two, so it keeps it.
    if (after.length === 0 && found.startIndex > 0) after.push("");
    text = [...found.lines.slice(0, found.startIndex), ...after].join("\n");
    changes.push({
      path: GITIGNORE_PATH,
      integration: record.integration,
      type: "update",
      removedLines: record.lines,
    });
  }

  for (const { integration, lines } of declared) {
    const wanted = lines.join("\n");
    const recorded = records.find((record) => record.integration === integration);
    if (text === undefined) {
      text = blockText(integration, lines, "");
      changes.push({ path: GITIGNORE_PATH, integration, type: "write", lines });
      nextRecords.push({ integration, lines });
      continue;
    }

    const found = findBlock(GITIGNORE_PATH, text, integration);
    if ("reason" in found) {
      conflicts.push(found.reason);
      continue;
    }

    if (found.startIndex === -1) {
      // The person's last line keeps its bytes; it only gains the line break it lacked.
      const separator = text === "" || text.endsWith("\n") ? "" : `${found.cr}\n`;
      text = `${text}${separator}${blockText(integration, lines, found.cr)}`;
      changes.push({
        path: GITIGNORE_PATH,
        integration,
        type: contents === undefined ? "write" : "update",
        lines,
      });
    } else if (found.current === wanted) {
      changes.push({ path: GITIGNORE_PATH, integration, type: "unchanged", lines });
    } else if (recorded !== undefined && found.current === recorded.lines.join("\n")) {
      // The new lines take the line ending of the block's own start marker, so a block keeps one
      // line ending even in a file that mixes them.
      const blockCr = found.lines[found.startIndex]?.endsWith("\r") ? "\r" : "";
      text = [
        ...found.lines.slice(0, found.startIndex + 1),
        ...lines.map((line) => `${line}${blockCr}`),
        ...found.lines.slice(found.endIndex),
      ].join("\n");
      changes.push({
        path: GITIGNORE_PATH,
        integration,
        type: "update",
        lines,
        previousLines: recorded.lines,
      });
    } else {
      conflicts.push(
        `${GITIGNORE_PATH}: the Calavera block for ${integration} ${recorded === undefined ? "is already in the file, and Calavera has no record of writing it" : "was edited since Calavera wrote it"}.\n${recorded === undefined ? "" : `Calavera wrote:\n${indent(recorded.lines.join("\n"))}\n`}The file now holds:\n${indent(found.current)}\nCalavera would write:\n${indent(wanted)}\nTo let Calavera write it, remove the block, both markers included, and run apply again.`,
      );
      continue;
    }
    nextRecords.push({ integration, lines });
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Calavera stopped before writing anything, because ${GITIGNORE_PATH} conflicts with the blocks Calavera manages there:\n${conflicts.map((reason) => `- ${reason}`).join("\n")}`,
    );
  }

  const type =
    changes.length === 0
      ? undefined
      : contents === undefined
        ? "write"
        : text === contents
          ? "unchanged"
          : "update";
  return { contents: text, type, changes, records: nextRecords };
}

/**
 * The text of the managed `.htmlvalidateignore`: every line the selected integrations declare for
 * it, in catalog order, each once.
 *
 * @param {{ id: string, ignore?: Partial<Record<IgnoreFile, string[]>> }[]} integrations
 * @returns {string}
 */
export function htmlValidateIgnoreText(integrations) {
  const lines = declaredIgnoreLines(integrations, "htmlValidateIgnore").flatMap(
    ({ lines: declared }) => declared,
  );
  return [...new Set(lines)].map((line) => `${line}\n`).join("");
}

/**
 * What the managed `.htmlvalidateignore` gains and loses, for the dry run. Apply writes the file as
 * a whole, in catalog order with each line once, so an integration's lines are unchanged only when
 * the file holds every one of them where apply would put them. An integration whose lines the file
 * holds in another order is an update that reports the order the file holds. Lines the file holds
 * that no selected integration declares are removed.
 *
 * @param {{ id: string, ignore?: Partial<Record<IgnoreFile, string[]>> }[]} integrations
 * @param {string | undefined} current The file now, or undefined when it does not exist.
 * @returns {IgnoreChange[]}
 */
export function planHtmlValidateIgnoreChanges(integrations, current) {
  const declared = declaredIgnoreLines(integrations, "htmlValidateIgnore");
  const currentLines =
    current === undefined
      ? undefined
      : [...new Set(current.split(/\r?\n/).filter((line) => line.trim() !== ""))];
  const currentSet = new Set(currentLines);

  // The lines each integration writes: a line two integrations declare belongs to the first one.
  const claimed = new Set();
  const written = declared.map(({ lines }) =>
    lines.filter((line) => {
      if (claimed.has(line)) return false;
      claimed.add(line);
      return true;
    }),
  );

  // The file's lines that stay, in the order the file holds them. Where the file lacks a line,
  // `staying` and the expected order both skip it, so one missing line does not shift the lines
  // of the integrations after it.
  const staying = (currentLines ?? []).filter((line) => claimed.has(line));
  let offset = 0;
  /** @type {IgnoreChange[]} */
  const changes = declared.map(({ integration, lines }, index) => {
    const base = { path: HTML_VALIDATE_IGNORE_PATH, integration, lines };
    if (currentLines === undefined) return { ...base, type: "write" };
    const expected = written[index] ?? [];
    const length = expected.filter((line) => currentSet.has(line)).length;
    const held = staying.slice(offset, offset + length);
    offset += length;
    if (!lines.every((line) => currentSet.has(line))) return { ...base, type: "update" };
    return held.every((line, position) => line === expected[position])
      ? { ...base, type: "unchanged" }
      : { ...base, type: "update", previousLines: held };
  });
  const removedLines = (currentLines ?? []).filter((line) => !claimed.has(line));
  if (removedLines.length > 0) {
    changes.push({ path: HTML_VALIDATE_IGNORE_PATH, type: "update", removedLines });
  }
  return changes;
}
