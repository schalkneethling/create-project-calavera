// @ts-check
// The lines the apply and clean summaries print for an artifact's part of .claude/settings.json,
// so the two summaries describe a hook group change in the same words (#1145). Each line sits
// under the settings file's one line and names the artifact whose group it is, because the groups
// of several artifacts sit under that one line (owner decision on #1145).
import { tense } from "./summary-lines.js";
import { quoteScriptValue } from "./utils/text.js";

/**
 * One hook group apply or clean adds, replaces, or removes for `artifact`. A group removed
 * because the recipe no longer selects the artifact says so.
 *
 * @param {import("./ai/claude-settings.js").HookGroupChange} change
 * @param {{ artifact: string, dryRun: boolean, deselected?: boolean }} options
 */
export function hookGroupChangeLine(
  { event, action, group, previous },
  { artifact, dryRun, deselected = false },
) {
  if (action === "add") {
    return `${tense(dryRun, "Would add", "Added")} a ${event} group for ${artifact}: ${quoteScriptValue(group)}`;
  }
  if (action === "replace") {
    return `${tense(dryRun, "Would replace", "Replaced")} the ${event} group for ${artifact}: ${quoteScriptValue(previous)} with ${quoteScriptValue(group)}`;
  }
  const because = deselected ? `, because the recipe no longer selects ${artifact}` : "";
  return `${tense(dryRun, "Would remove", "Removed")} the ${event} group for ${artifact}${because}: ${quoteScriptValue(previous)}`;
}

/**
 * Says that rewriting the settings file also changes the layout of the text outside the groups.
 *
 * @param {boolean} dryRun
 */
export function settingsLayoutLine(dryRun) {
  return `${tense(dryRun, "Would also change", "Also changed")} the layout of the rest of the file, because Calavera writes the whole file in the project's format; no value outside the groups changes`;
}
