// @ts-check
import { inspect, isDeepStrictEqual } from "node:util";

import { formatJSON, rewriteLossProblem } from "../utils/oxfmt-json.js";
import { viteHookCommandProblem } from "./vite-hook-blocks.js";

// ADR-0015, Decision 5: apply adds an artifact's Claude Code hook groups to the committed
// .claude/settings.json, keeps every other key, event, and group, and replaces a group only while
// it still matches what apply wrote last. Calavera never writes .claude/settings.local.json.

// The project root as Claude Code gives it to every hook command. In a .claude/worktrees
// worktree it still names the main checkout, which holds the same committed scripts.
const PROJECT_DIR_COMMAND = /^node "\$CLAUDE_PROJECT_DIR\/([^"]*)"((?: .*)?)$/;

/**
 * @typedef {{ type: "command", command: string, timeout?: number }} CommandHook
 * @typedef {{ matcher?: string, hooks: CommandHook[] }} HookGroup
 * @typedef {Record<string, HookGroup[]>} HookGroups Matcher groups keyed by hook event, such as PreToolUse.
 *
 * @typedef {object} HookGroupChange
 * @property {string} event
 * @property {"add" | "replace" | "remove"} action
 * @property {HookGroup} [group] The group apply writes; absent when it removes one.
 * @property {HookGroup} [previous] The group it replaces or removes.
 *
 * @typedef {object} ClaudeSettingsPlan
 * @property {"write" | "update" | "unchanged" | "conflict"} type
 * @property {HookGroupChange[]} changes
 * @property {HookGroups} [groups] The groups to record as written, so the next apply can tell them from an edit. Absent on a conflict, because nothing is written.
 * @property {string} [contents] The settings text after apply, unless the plan is a conflict.
 * @property {boolean} [reformatted] Whether the rewrite also changes the layout of text outside the hook groups, which the dry run must show.
 * @property {string} [reason] Why apply stops, when it is a conflict.
 */

/**
 * Returns why `command` may not go into .claude/settings.json, or undefined when it may. It must
 * run a script from the artifact's skill directory as `node "$CLAUDE_PROJECT_DIR/<script>"`, and
 * every other word is held to the same shell-safe rule as a .vite-hooks command.
 *
 * @param {string} command
 * @param {string} skillDirectory
 * @returns {string | undefined}
 */
export function claudeHookCommandProblem(command, skillDirectory) {
  if (/[\r\n]/.test(command)) {
    return `"${command}" must be a single line.`;
  }
  const match = PROJECT_DIR_COMMAND.exec(command);
  const directory = skillDirectory.replace(/\/+$/, "");
  if (!match || !match[1]?.startsWith(`${directory}/`)) {
    return `"${command}" must start with node "$CLAUDE_PROJECT_DIR/${directory}/" followed by a script in that directory and a closing quote.`;
  }
  // The shell reads a quoted space as part of one path, which the word check below would miss.
  if (match[1].includes(" ")) {
    return `"${command}": the script path must not contain a space.`;
  }
  // The script path is checked without its quotes, and the message names the command as written.
  const unquoted = `node ${match[1]}${match[2]}`;
  return viteHookCommandProblem(unquoted, directory)?.replace(`"${unquoted}"`, `"${command}"`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the artifact's fragment, which ships in its payload. A fragment that breaks a rule is a
 * defect in the artifact, so it throws instead of becoming a conflict.
 *
 * @param {unknown} fragment
 * @param {string} skillDirectory
 * @returns {HookGroups}
 */
function fragmentGroups(fragment, skillDirectory) {
  if (!isObject(fragment) || Object.keys(fragment).some((key) => key !== "hooks")) {
    throw new Error('The Claude Code settings fragment may hold only "hooks".');
  }
  const { hooks } = fragment;
  if (!isObject(hooks)) throw new Error("The fragment's hooks must be an object.");
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.length === 0) {
      throw new Error(`The fragment's hooks.${event} must be a non-empty array.`);
    }
    for (const [index, group] of groups.entries()) {
      const at = `The fragment's hooks.${event}[${index}]`;
      if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) {
        throw new Error(`${at} must hold a non-empty hooks array.`);
      }
      if (Object.keys(group).some((key) => key !== "matcher" && key !== "hooks")) {
        throw new Error(`${at} may hold only matcher and hooks.`);
      }
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        throw new Error(`${at}.matcher must be a string.`);
      }
      for (const handler of group.hooks) {
        if (
          !isObject(handler) ||
          handler.type !== "command" ||
          typeof handler.command !== "string"
        ) {
          throw new Error(`${at} must be a command hook with a command string.`);
        }
        if (
          handler.timeout !== undefined &&
          (!Number.isInteger(handler.timeout) || /** @type {number} */ (handler.timeout) <= 0)
        ) {
          throw new Error(`${at}: timeout must be a positive whole number of seconds.`);
        }
        const problem = claudeHookCommandProblem(handler.command, skillDirectory);
        if (problem) throw new Error(`${at}: ${problem}`);
      }
    }
  }
  return /** @type {HookGroups} */ (hooks);
}

/**
 * @param {unknown} group
 * @param {string} skillDirectory
 */
function runsSkill(group, skillDirectory) {
  return (
    isObject(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.some((handler) => handlerRunsSkill(handler, skillDirectory))
  );
}

/**
 * Whether a hook handler's command runs a script from the skill directory: the directory path
 * starts the command's path, either from $CLAUDE_PROJECT_DIR or as a relative path. A copy of the
 * directory elsewhere, such as vendor/.agents/skills/..., is not the skill.
 *
 * @param {unknown} handler
 * @param {string} skillDirectory
 */
function handlerRunsSkill(handler, skillDirectory) {
  if (!isObject(handler) || typeof handler.command !== "string") return false;
  const directory = skillDirectory.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'=]|\\$CLAUDE_PROJECT_DIR/)${directory}/`).test(handler.command);
}

/**
 * Shows a group in a conflict message. A group from the person's file can hold a value formatJSON
 * refuses, such as a number too large to write, and the message must still show it.
 *
 * @param {unknown} group
 */
function showGroup(group) {
  try {
    return indent(formatJSON(group));
  } catch {
    return indent(inspect(group, { depth: null }));
  }
}

/**
 * @param {string} text
 */
function indent(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((row) => `  ${row}`)
    .join("\n");
}

/**
 * The groups apply recorded for `event`, checked, because a damaged record must not decide what
 * counts as an edit.
 *
 * @param {HookGroups | undefined} recorded
 * @param {string} event
 * @param {string} artifactId
 * @returns {unknown[]}
 */
function recordedGroups(recorded, event, artifactId) {
  const groups = recorded?.[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) {
    throw new Error(
      `The Calavera state record for ${artifactId} is damaged: its hooks.${event} is not a list of matcher groups.`,
    );
  }
  return groups;
}

/**
 * Plans apply's hook groups in .claude/settings.json. For each event in the fragment or the
 * record, a group equal to a fragment group stays; a group equal to one apply recorded is
 * replaced in place by a fragment group not yet in the file, or removed when none is left; any
 * other group that runs the skill's scripts is a conflict; and every fragment group still missing
 * is added at the end of its event. A rewrite that would lose a value elsewhere in the file is a
 * conflict too.
 *
 * @param {object} options
 * @param {string} options.path The settings path to name in a conflict, such as .claude/settings.json.
 * @param {string | undefined} options.contents The settings text now, or undefined when it does not exist.
 * @param {string} options.artifactId
 * @param {unknown} options.fragment The artifact's fragment, with its placeholders filled.
 * @param {HookGroups | undefined} options.recorded The groups apply wrote last, from the state record.
 * @param {string} options.skillDirectory The installed skill directory, such as .agents/skills/protected-branch-guard.
 * @returns {ClaudeSettingsPlan}
 */
export function planClaudeSettings({
  path,
  contents,
  artifactId,
  fragment,
  recorded,
  skillDirectory,
}) {
  const groups = fragmentGroups(fragment, skillDirectory);
  const directory = `${skillDirectory.replace(/\/+$/, "")}/`;
  /** @param {string} reason @returns {ClaudeSettingsPlan} */
  const conflict = (reason) => ({ type: "conflict", changes: [], reason: `${path}: ${reason}` });

  /** @type {unknown} */
  let settings = {};
  if (contents !== undefined) {
    try {
      settings = JSON.parse(contents);
    } catch (error) {
      return conflict(
        `is not valid JSON (${error instanceof Error ? error.message : String(error)}). Calavera does not rewrite a file it cannot read. Fix the JSON and run apply again.`,
      );
    }
  }
  if (!isObject(settings)) {
    return conflict("must hold a JSON object, which is what Claude Code reads.");
  }
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    return conflict("hooks must be an object of hook events, which is what Claude Code reads.");
  }
  /** @type {Record<string, unknown>} */
  const hooks = { ...settings.hooks };

  /** @type {HookGroupChange[]} */
  const changes = [];
  if (recorded !== undefined && recorded !== null && !isObject(recorded)) {
    throw new Error(
      `The Calavera state record for ${artifactId} is damaged: its hooks are not an object of hook events.`,
    );
  }
  const hadHooks = isObject(settings.hooks) && Object.keys(settings.hooks).length > 0;
  const events = new Set([...Object.keys(groups), ...Object.keys(recorded ?? {})]);
  for (const event of events) {
    const desired = groups[event] ?? [];
    const written = recordedGroups(recorded, event, artifactId);
    const existing = hooks[event] ?? [];
    if (!Array.isArray(existing)) {
      return conflict(
        `hooks.${event} must be an array of matcher groups, which is what Claude Code reads.`,
      );
    }

    // First pass: a group already equal to a fragment group stays, wherever it is, so a recorded
    // group is never paired with a fragment group the file already holds.
    const remaining = [...desired];
    const kept = existing.map((group) => {
      const same = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, group));
      if (same === -1) return false;
      remaining.splice(same, 1);
      return true;
    });

    /** @type {unknown[]} */
    const next = [];
    for (const [index, group] of existing.entries()) {
      if (kept[index] || !runsSkill(group, skillDirectory)) {
        next.push(group);
      } else if (written.some((candidate) => isDeepStrictEqual(candidate, group))) {
        const replacement = remaining.shift();
        const previous = /** @type {HookGroup} */ (group);
        if (replacement === undefined) {
          changes.push({ event, action: "remove", previous });
        } else {
          next.push(replacement);
          changes.push({ event, action: "replace", group: replacement, previous });
        }
      } else {
        const shared = /** @type {HookGroup} */ (group).hooks.some(
          (handler) => !handlerRunsSkill(handler, skillDirectory),
        );
        return conflict(
          `hooks.${event} holds a group that runs ${directory} and ${written.length === 0 ? "Calavera has no record of writing it" : "was edited since Calavera wrote it"}.\nThe file now holds:\n${showGroup(group)}\nCalavera would write:\n${desired.map((candidate) => indent(formatJSON(candidate))).join("\n") || "  nothing"}\nTo let Calavera write ${artifactId}'s hooks, ${shared ? `remove only the hook in that group that runs ${directory}, keep your other hooks,` : "remove that group"} and run apply again.`,
        );
      }
    }
    for (const group of remaining) {
      next.push(group);
      changes.push({ event, action: "add", group });
    }
    if (next.length === 0 && existing.length > 0) {
      delete hooks[event];
    } else if (next.length > 0) {
      hooks[event] = next;
    }
  }

  if (contents !== undefined && changes.length === 0) {
    return { type: "unchanged", groups, changes, contents, reformatted: false };
  }
  if (contents !== undefined) {
    const loss = rewriteLossProblem(contents);
    if (loss !== undefined) {
      return conflict(
        `${loss}. Calavera rewrites the whole file to add its hooks, so it stops instead of changing that silently. Edit that part of the file and run apply again.`,
      );
    }
  }
  return {
    type: contents === undefined ? "write" : "update",
    groups,
    changes,
    // Apply's removals can empty hooks; an empty hooks object that apply left behind goes too.
    contents: formatJSON(
      hadHooks && Object.keys(hooks).length === 0
        ? Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "hooks"))
        : { ...settings, hooks },
    ),
    reformatted: contents !== undefined && formatJSON(settings) !== contents,
  };
}
