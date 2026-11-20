// @ts-check
// The human-readable summary of `eject --dry-run`, the list `eject` shows before it asks for
// approval, and what `eject` reports when it is done (#678, ADR-0017 Decisions 4, 5, and 8). It
// follows the layout `clean` uses (#331): a headline, then labeled groups, with each item listed
// once. An item's details sit under it: why it is edited or unknown, what the change does besides
// removing Calavera's text, and, for an edit, the exact lines it removes and the text the file
// holds afterward. Quoted values are the exact text, as `clean` and apply quote a script's command.
// The `--json` result carries the same items without these lines.
import { posix } from "node:path";

import { withoutOwnPath } from "./clean-summary.js";
import { DETAIL, ITEM, info, pushGroup } from "./summary-lines.js";
import { quoteScriptValue } from "./utils/text.js";

/**
 * @typedef {import("./index.js").EjectResult} EjectResult
 * @typedef {import("./index.js").EjectResultItem} EjectResultItem
 * @typedef {import("./summary-lines.js").SummaryLine} SummaryLine
 */

/** The lines under an edit that show text: each one quoted, one level deeper than the label. */
const TEXT = `${DETAIL}  `;

/**
 * The lines `eject` prints for `result`, in order.
 *
 * @param {EjectResult} result
 * @returns {SummaryLine[]}
 */
export function ejectSummaryLines(result) {
  /** @type {SummaryLine[]} */
  const lines = [info(result.message)];
  /** @param {EjectResultItem["outcome"]} outcome */
  const withOutcome = (outcome) => result.items.filter((item) => item.outcome === outcome);
  // A report about a path that is also an item, such as a hand-merged marker in an AGENTS.md whose
  // section eject removes, goes under that item, so each path is printed once.
  const itemPaths = new Set(result.items.map(({ path }) => path));
  /** @param {EjectResultItem} item */
  const reportsFor = (item) =>
    result.reported.filter(({ path }) => path === item.path).map(({ reason }) => reason);
  /** @param {EjectResultItem} item */
  const itemLines = (item) => ownItemLines(item, reportsFor(item));
  /** @param {EjectResultItem} item */
  const samePathReports = (item) =>
    reportsFor(item).map((reason) => info(`${DETAIL}${withoutOwnPath(reason, item.path)}`));

  pushGroup(lines, "Would remove", withOutcome("planned").flatMap(itemLines));
  pushGroup(lines, "Removed", withOutcome("removed").flatMap(itemLines));
  pushGroup(lines, "Left for an interactive run", withOutcome("left").flatMap(itemLines));
  pushGroup(
    lines,
    "Failed",
    withOutcome("failed").flatMap((item) => [
      info(`${ITEM}${item.path}: ${withoutOwnPath(item.error ?? "", item.path)}`),
      ...samePathReports(item),
      info(`${DETAIL}Fix the cause, then run eject again.`),
    ]),
  );
  pushGroup(
    lines,
    "Skipped",
    withOutcome("skipped").flatMap((item) => [
      info(`${ITEM}${item.path}: ${withoutOwnPath(item.error ?? "", item.path)}`),
      ...samePathReports(item),
    ]),
  );
  pushGroup(
    lines,
    "Kept",
    result.kept.map((path) =>
      info(`${ITEM}${path}: eject does not name it, so it keeps it and the folder that holds it.`),
    ),
  );
  pushGroup(
    lines,
    "Left for you",
    reportedLines(result.reported.filter(({ path }) => !itemPaths.has(path))),
  );
  pushGroup(lines, "Left in package.json", packageJsonLines(result.packageJson));
  pushGroup(
    lines,
    "Elsewhere in the workspace",
    result.elsewhere.map(({ directory, paths }) =>
      info(
        `${ITEM}${directory} also holds Calavera's footprint: ${paths.map((path) => posix.join(directory, path)).join(", ")}. Run eject there too if you want Calavera gone from it.`,
      ),
    ),
  );
  return lines;
}

/**
 * What an item's check found, in words, and whether `--yes` leaves it.
 *
 * @param {EjectResultItem} item
 */
function editsLabel({ kind, edits, matchesRecords, outcome, keptRecord }) {
  const found =
    edits === "not-checked"
      ? kind === "state" || kind === "lock"
        ? "Calavera's own record"
        : "Calavera's own files"
      : edits === "cannot-detect"
        ? "edits cannot be detected"
        : edits;
  // A record --yes keeps needs no approval of its own, so it says why it stays. Only an item that
  // --yes plans to leave, or left, is a kept record. Only a list that comes before the removal says
  // what --yes would do; a run that is done says what it did under its own heading.
  if (keptRecord) {
    return `${found}; --yes keeps it while an item it leaves needs it`;
  }
  return outcome === "planned" && !matchesRecords ? `${found}; --yes leaves it` : found;
}

/**
 * @param {EjectResultItem} item
 * @param {string[]} reports What `eject` reports about the same path, such as a hand-merged marker
 *   in the `AGENTS.md` whose section it removes, printed with the item's own reason.
 * @returns {SummaryLine[]}
 */
function ownItemLines(item, reports) {
  /** @type {SummaryLine[]} */
  const lines = [info(`${ITEM}${item.path} (${editsLabel(item)})`)];
  if (item.action === "edit") {
    lines.push(
      info(`${DETAIL}eject removes only Calavera's text from this file and keeps the file.`),
    );
  }
  if (item.reason) lines.push(info(`${DETAIL}${withoutOwnPath(item.reason, item.path)}`));
  if (item.note) lines.push(info(`${DETAIL}${withoutOwnPath(item.note, item.path)}`));
  for (const report of reports) lines.push(info(`${DETAIL}${withoutOwnPath(report, item.path)}`));
  // The text an edit removes, and what the file holds afterward, belong to the list a person
  // approves or still has to approve; a removal that is done does not print them again. Failed
  // and skipped items have lines of their own.
  if (item.outcome === "removed") {
    return lines;
  }
  if (item.removedLines) {
    lines.push(
      info(`${DETAIL}Removes${item.around ? `, from line ${item.around.line}` : ""}:`),
      ...item.removedLines.map(quoted),
    );
  }
  if (item.around && (item.around.before !== undefined || item.around.after !== undefined)) {
    lines.push(info(`${DETAIL}Around it, with values hidden:`));
    if (item.around.before !== undefined) {
      lines.push(info(`${TEXT}Before: ${quoteScriptValue(item.around.before)}`));
    }
    if (item.around.after !== undefined) {
      lines.push(info(`${TEXT}After: ${quoteScriptValue(item.around.after)}`));
    }
  }
  if (item.contents !== undefined) {
    const text = item.contents.endsWith("\n") ? item.contents.slice(0, -1) : item.contents;
    lines.push(info(`${DETAIL}Afterward:`), ...text.split("\n").map(quoted));
  }
  return lines;
}

/** @param {string} line */
const quoted = (line) => info(`${TEXT}${quoteScriptValue(line)}`);

/**
 * Each reported path once, with every reason `eject` reports for it under it.
 *
 * @param {EjectResult["reported"]} reported
 * @returns {SummaryLine[]}
 */
function reportedLines(reported) {
  /** @type {Map<string, string[]>} */
  const byPath = new Map();
  for (const { path, reason } of reported) {
    byPath.set(path, [...(byPath.get(path) ?? []), reason]);
  }
  return [...byPath].flatMap(([path, reasons]) => [
    info(`${ITEM}${path}`),
    ...reasons.map((reason) => info(`${DETAIL}${withoutOwnPath(reason, path)}`)),
  ]);
}

/**
 * @param {EjectResult["packageJson"]} packageJson
 * @returns {SummaryLine[]}
 */
function packageJsonLines({ scripts, devDependency, problem }) {
  return [
    ...(problem === undefined ? [] : [info(`${ITEM}${problem}`)]),
    ...scripts.map(({ name, value }) =>
      info(
        `${ITEM}The script ${quoteScriptValue(name)} runs Calavera: ${quoteScriptValue(value)}. It stops working once Calavera is gone, so change or remove it yourself.`,
      ),
    ),
    ...(devDependency
      ? [
          info(`${ITEM}The development dependency ${devDependency.name} stays. To remove it, run:`),
          info(`${DETAIL}${devDependency.removeCommand}`),
        ]
      : []),
  ];
}
