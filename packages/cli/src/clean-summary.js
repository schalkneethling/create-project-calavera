// @ts-check
// The human-readable summary of `clean --dry-run` and `clean` (#331): a headline, then labeled
// groups, as the apply summary prints them (#617), with each wiring file, managed file, and
// artifact listed once. A skip reason may still name a wiring file it refers to, such as a hook
// that still runs a kept skill, because the person needs that name to act. Wiring sits first, because clean changes it before it removes anything;
// each wiring file is one line, with each artifact's blocks and groups under it. Each kept item
// carries its own reason and remedy, so the summary leaves out the sentence the `--json` message
// adds about kept items. The `--json` result keeps its shape and text.
import { DETAIL, ITEM, info, pushGroup, tense } from "./summary-lines.js";
import { quoteScriptValue } from "./utils/text.js";

/**
 * @typedef {import("./index.js").CleanResult} CleanResult
 * @typedef {import("./index.js").Change} Change
 * @typedef {import("./ai/artifact-wiring.js").WiringChange} WiringChange
 * @typedef {import("./summary-lines.js").SummaryLine} SummaryLine
 */

/**
 * The first sentence of what clean reports: what it removed, would remove, or found. The `--json`
 * message is this sentence, followed by one sentence for each reason clean kept stale items.
 *
 * @param {{ dryRun: boolean, removed: number, wiringFiles: number, kept: number }} counts
 *   `removed` counts the stale files and artifacts clean removes, `wiringFiles` the wiring files it
 *   changes, and `kept` the stale items it keeps.
 */
export function cleanHeadline({ dryRun, removed, wiringFiles, kept }) {
  if (removed === 0 && wiringFiles === 0) {
    return kept > 0
      ? "No stale managed items were safe to remove."
      : "No stale managed files found.";
  }
  if (dryRun) return "Dry run complete. No files were removed.";
  if (removed === 0) return "Removed the wiring of artifacts the recipe no longer selects.";
  if (wiringFiles === 0) return "Removed stale managed files.";
  return "Removed stale managed files and the wiring of artifacts the recipe no longer selects.";
}

/**
 * The lines `clean --dry-run` and `clean` print for `result`, in order. A result with nothing to
 * list, such as a cancelled clean or a project without state, prints its message alone.
 *
 * @param {CleanResult} result
 * @param {boolean} dryRun
 * @returns {SummaryLine[]}
 */
export function cleanSummaryLines(result, dryRun) {
  // A wiring change always comes with the change to its file, so no changes means nothing to list.
  if (result.changes.length === 0) {
    return [info(result.message)];
  }

  const wiringFileChanges = result.changes.filter(isWiringFileChange);
  /** @type {SummaryLine[]} */
  const lines = [
    info(
      cleanHeadline({
        dryRun,
        removed: result.changes.filter(({ type }) => type === "delete").length,
        wiringFiles: wiringFileChanges.length,
        kept: result.changes.filter(({ type }) => type === "skip").length,
      }),
    ),
  ];

  pushGroup(lines, "Wiring", wiringLines(wiringFileChanges, result.wiringChanges, dryRun));
  pushGroup(
    lines,
    "Files",
    result.changes
      .filter((change) => change.category !== "ai" && !isWiringFileChange(change))
      .map((change) => itemLine(change, dryRun)),
  );
  pushGroup(
    lines,
    "Artifacts",
    result.changes
      .filter((change) => change.category === "ai")
      .map((change) => itemLine(change, dryRun)),
  );

  return lines;
}

/**
 * A wiring file clean rewrites, as opposed to a stale item it removes or keeps.
 *
 * @param {Change} change
 */
function isWiringFileChange({ type }) {
  return type !== "delete" && type !== "skip";
}

/**
 * @param {Change} change A removed or kept stale item.
 * @param {boolean} dryRun
 */
function itemLine({ type, path, reason = "" }, dryRun) {
  return info(
    type === "skip"
      ? `${ITEM}${tense(dryRun, "Would skip", "Skipped")} ${path}: ${withoutOwnPath(reason, path)}`
      : `${ITEM}${tense(dryRun, "Would remove", "Removed")} ${path}`,
  );
}

/**
 * The reason with each mention of the kept item's own path replaced by "this item", or "This item"
 * at the start of a sentence, because the
 * item's line already names it. "It" would be unclear in reasons that already use "it" for
 * Calavera or a hook, such as "so it cannot tell whether it runs this item". A longer path that starts with it, such as a script inside a kept skill
 * directory, stays as it is.
 *
 * @param {string} reason
 * @param {string} path
 */
export function withoutOwnPath(reason, path) {
  let text = "";
  let from = 0;
  for (let index = reason.indexOf(path); index >= 0; index = reason.indexOf(path, index + 1)) {
    const before = reason[index - 1] ?? " ";
    const after = reason.slice(index + path.length, index + path.length + 2);
    // A period that ends the sentence is not part of the path.
    if (PATH_CHARACTER.test(before) || /^(?:[\w/@-]|\.[\w/@-])/.test(after)) continue;
    // At the start of a sentence, the words start with a capital, as the path they replace did.
    const startsSentence = /(?:^|[.!?]\s+)$/.test(reason.slice(0, index));
    text += `${reason.slice(from, index)}${startsSentence ? "This item" : "this item"}`;
    from = index + path.length;
  }
  return text + reason.slice(from);
}

const PATH_CHARACTER = /[\w./@-]/;

/**
 * Each wiring file once, with each artifact's part of it under the file's line, so the path is
 * not named again.
 *
 * @param {Change[]} fileChanges
 * @param {WiringChange[]} wiringChanges
 * @param {boolean} dryRun
 * @returns {SummaryLine[]}
 */
function wiringLines(fileChanges, wiringChanges, dryRun) {
  // Clean only rewrites a wiring file to remove an artifact's part of it, so each path is in both.
  const paths = new Set([...fileChanges, ...wiringChanges].map(({ path }) => path));

  return [...paths].flatMap((path) => [
    info(`${ITEM}${tense(dryRun, "Would update", "Updated")} ${path}`),
    ...wiringChanges
      .filter((change) => change.path === path)
      .flatMap((change) => wiringChangeLines(change, dryRun))
      .map((line) => info(`${DETAIL}${line}`)),
  ]);
}

/**
 * The lines for one artifact's part of a wiring file, under the file's own line; the approval
 * covers the exact text. Clean plans the wiring with no selected artifacts, so every change it
 * reports removes the block or groups of an artifact the recipe no longer selects: a hook change
 * always has `removedBlock`, and a settings change only removes groups (`planArtifactWiring`).
 *
 * @param {WiringChange} change
 * @param {boolean} dryRun
 * @returns {string[]}
 */
function wiringChangeLines({ artifact, removedBlock, groupChanges, reformatted }, dryRun) {
  const removed = tense(dryRun, "Would remove", "Removed");
  const because = `because the recipe no longer selects ${artifact}`;
  if (removedBlock !== undefined) {
    return [`${removed} the ${artifact} block, ${because}: ${quoteScriptValue(removedBlock)}`];
  }
  return [
    ...(groupChanges ?? []).map(
      ({ event, previous }) =>
        `${removed} the ${event} group for ${artifact}, ${because}: ${quoteScriptValue(previous)}`,
    ),
    ...(reformatted
      ? [
          `${tense(dryRun, "Would also change", "Also changed")} the layout of the rest of the file, because Calavera writes the whole file in the project's format; no value outside the groups changes`,
        ]
      : []),
  ];
}
