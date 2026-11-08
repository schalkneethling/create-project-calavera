// @ts-check
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import { resolveAiArtifacts } from "./artifacts.js";
import { planClaudeSettings, runsSkill } from "./claude-settings.js";
import {
  fillInputPlaceholders,
  planViteHookBlock,
  planViteHookBlockRemoval,
  readViteHookBlock,
  viteHookCommandProblem,
} from "./vite-hook-blocks.js";

const execFileAsync = promisify(execFile);

// ADR-0015, Decisions 4 and 5: a skill's manifest can wire the installed skill into the project's
// .vite-hooks scripts and .claude/settings.json. Apply plans the wiring of every selected artifact
// before it writes anything, so a conflict in any file stops apply with nothing written, and the
// dry run shows the exact lines and groups that apply then writes.

const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
// The person's own Claude Code settings. Calavera never writes it, but clean reads it, because a
// hook the person wired there fails once its script is gone.
const CLAUDE_LOCAL_SETTINGS_PATH = ".claude/settings.local.json";
// The directory `vp config` installs the dispatcher into when the hooks directory is .vite-hooks,
// and the value it sets core.hooksPath to (node_modules/vite-plus/docs/guide/commit-hooks.md).
const VITE_HOOKS_DISPATCHER = ".vite-hooks/_";

/**
 * @typedef {import("@schalkneethling/calavera-artifact-core").ArtifactWiring} ArtifactWiring
 * @typedef {import("@schalkneethling/calavera-artifact-core").ArtifactInput} ArtifactInput
 * @typedef {import("./claude-settings.js").HookGroups} HookGroups
 * @typedef {import("./claude-settings.js").HookGroupChange} HookGroupChange
 * @typedef {import("../utils/project-formatter.js").ProjectFormatter} ProjectFormatter
 * @typedef {import("./artifacts.js").AiArtifactState} AiArtifactState
 *
 * @typedef {object} WiredArtifact A selected skill, as apply installs it.
 * @property {string} id
 * @property {number} index Its index in the recipe's ai list, where its input values are recorded.
 * @property {string} skillDirectory Where the skill is installed, such as .agents/skills/protected-branch-guard.
 * @property {string} payloadDirectory Where its payload is read from, which holds the Claude Code fragment.
 *
 * @typedef {object} WiringRecord What apply wrote for one artifact, kept in the state record so a later apply can tell its own text from an edit.
 * @property {string} artifact
 * @property {Record<string, string>} [viteHooks] The command line in each hook's block.
 * @property {HookGroups} [claudeCode] The groups in .claude/settings.json.
 *
 * @typedef {object} WiringFile
 * @property {string} path
 * @property {"write" | "update" | "unchanged"} type
 * @property {string} contents The file's text after apply.
 *
 * @typedef {object} WiringChange One artifact's part of a wiring file, for the dry run.
 * @property {string} artifact
 * @property {string} path
 * @property {"vite-hook" | "claude-settings"} kind
 * @property {"write" | "update" | "unchanged"} type
 * @property {string} [block] The command line in the artifact's block, for a vite-hook change.
 * @property {string} [removedBlock] The command line of a block apply removes, because the artifact no longer wires that hook or the recipe no longer selects the artifact.
 * @property {HookGroupChange[]} [groupChanges] The groups added, replaced, or removed, for a claude-settings change.
 * @property {boolean} [reformatted] Whether rewriting .claude/settings.json also changes the layout of text outside the groups.
 * @property {true} [deselected] Present when apply removes the change's text because the recipe no longer selects the artifact.
 *
 * @typedef {object} WiringFinding What doctor reports about one recorded block or group.
 * @property {"error" | "warning"} level
 * @property {string} message Names the file and the remedy.
 */

/** @param {string} id @returns {ArtifactWiring | undefined} */
function catalogWiring(id) {
  return artifactForId(id)?.wiring;
}

/** @param {string} id @returns {Record<string, ArtifactInput> | undefined} */
function catalogInputs(id) {
  return artifactForId(id)?.inputs;
}

/**
 * The selected artifacts that write Git hooks. Git runs a hook from the repository root, so these
 * apply at the repository root only.
 *
 * @param {{ ai?: unknown }} recipe
 * @param {(id: string) => ArtifactWiring | undefined} [wiringFor]
 * @returns {string[]}
 */
export function gitHookArtifactIds(recipe, wiringFor = catalogWiring) {
  return (Array.isArray(recipe.ai) ? recipe.ai : []).flatMap((item) =>
    item &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    Object.keys(wiringFor(item.id)?.viteHooks ?? {}).length > 0
      ? [/** @type {string} */ (item.id)]
      : [],
  );
}

/** @param {string} path */
async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Replaces the placeholders in every string of a settings fragment.
 *
 * @param {unknown} value
 * @param {Record<string, string>} inputs
 * @returns {unknown}
 */
function fillFragment(value, inputs) {
  if (typeof value === "string") return fillInputPlaceholders(value, inputs);
  if (Array.isArray(value)) return value.map((item) => fillFragment(item, inputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillFragment(item, inputs)]),
    );
  }
  return value;
}

/** @param {{ ai?: unknown }} recipe @param {number} index @returns {Record<string, string>} */
function recordedInputs(recipe, index) {
  const item = Array.isArray(recipe.ai) ? recipe.ai[index] : undefined;
  const inputs = item && typeof item === "object" ? item.inputs : undefined;
  return inputs && typeof inputs === "object" ? /** @type {Record<string, string>} */ (inputs) : {};
}

/**
 * Where a skill the recipe no longer selects was installed: from the state record of installed
 * artifacts, or, when that entry is gone, from the catalog, which installs every skill under
 * .agents/skills/<name>.
 *
 * @param {string} id
 * @param {AiArtifactState[]} installed The aiArtifacts of the state record.
 * @returns {string | undefined}
 */
export function installedSkillDirectory(id, installed) {
  const entry = installed.find(({ type, source }) => type === "skill" && source === id);
  if (entry) return entry.path;
  if (artifactForId(id)?.type !== "skill") return undefined;
  return resolveAiArtifacts({ ai: [{ id }] })[0]?.path;
}

/**
 * Plans the wiring of every selected artifact, and the removal of the wiring of every recorded
 * artifact the recipe no longer selects (owner decision of 2026-11-05, ADR-0015, Decision 5).
 * Selected artifacts are planned in recipe order, then the deselected ones, and each one plans
 * against the text the one before it left, so two artifacts that wire the same file both land in
 * it. Any conflict stops the plan, after every file has been checked, so the error lists each one.
 *
 * The returned records describe the wiring in the files after apply, so they replace the previous
 * records: a deselected artifact whose wiring is removed has no record left.
 *
 * @param {object} options
 * @param {{ ai?: unknown }} options.recipe The recipe with every input value filled in.
 * @param {WiredArtifact[]} options.artifacts The selected skills.
 * @param {WiringRecord[]} options.previousRecords From the state record.
 * @param {() => Promise<ProjectFormatter>} options.loadFormatter Called only when an artifact wires .claude/settings.json.
 * @param {(id: string) => string | undefined} [options.skillDirectoryFor] Where a deselected skill was installed, so apply can tell its Claude Code groups from the person's.
 * @param {string} [options.cwd]
 * @param {(id: string) => ArtifactWiring | undefined} [options.wiringFor]
 * @returns {Promise<{ files: WiringFile[], changes: WiringChange[], records: WiringRecord[] }>}
 */
export async function planArtifactWiring({
  recipe,
  artifacts,
  previousRecords,
  loadFormatter,
  skillDirectoryFor = (id) => installedSkillDirectory(id, []),
  cwd = process.cwd(),
  wiringFor = catalogWiring,
}) {
  /** @type {Map<string, { original: string | undefined, contents: string | undefined }>} */
  const files = new Map();
  /** @type {WiringChange[]} */
  const changes = [];
  /** @type {WiringRecord[]} */
  const records = [];
  /** @type {string[]} */
  const conflicts = [];
  /** @type {ProjectFormatter | undefined} */
  let formatter;

  /** @param {string} path */
  const current = async (path) => {
    if (!files.has(path)) {
      const original = await readIfPresent(resolve(cwd, path));
      files.set(path, { original, contents: original });
    }
    return /** @type {{ original: string | undefined, contents: string | undefined }} */ (
      files.get(path)
    );
  };

  const selected = new Set(artifacts.map(({ id }) => id));
  // A recorded artifact the recipe no longer selects is planned with no wiring, so every block and
  // group it wrote is removed, or is a conflict when the person edited it.
  const planned = [
    ...artifacts.map((artifact) => ({ artifact, deselected: false })),
    ...previousRecords
      .filter((record) => !selected.has(record.artifact))
      .map((record) => ({
        artifact: {
          id: record.artifact,
          index: -1,
          skillDirectory: skillDirectoryFor(record.artifact),
          payloadDirectory: "",
        },
        deselected: true,
      })),
  ];

  for (const { artifact, deselected } of planned) {
    const previous = previousRecords.find((record) => record.artifact === artifact.id);
    // Wiring the catalog dropped still has recorded blocks and groups to remove.
    /** @type {ArtifactWiring | undefined} */
    const wiring = deselected ? {} : (wiringFor(artifact.id) ?? (previous ? {} : undefined));
    if (!wiring) continue;
    const inputs = recordedInputs(recipe, artifact.index);
    /** @type {WiringRecord} */
    const record = { artifact: artifact.id };
    const because = deselected
      ? `the recipe no longer selects ${artifact.id}`
      : `${artifact.id} no longer wires this hook`;

    // A hook the artifact wired before but no longer does loses its block, so it stops running.
    for (const [hook, recorded] of Object.entries(previous?.viteHooks ?? {})) {
      if (Object.hasOwn(wiring.viteHooks ?? {}, hook)) continue;
      const path = `.vite-hooks/${hook}`;
      const file = await current(path);
      const plan = planViteHookBlockRemoval({
        path,
        contents: file.contents,
        artifactId: artifact.id,
        recorded,
        because,
      });
      if (plan.type === "conflict") {
        conflicts.push(/** @type {string} */ (plan.reason));
      } else if (plan.type === "update") {
        file.contents = plan.contents;
        changes.push({
          artifact: artifact.id,
          path,
          kind: "vite-hook",
          type: "update",
          removedBlock: recorded,
          ...(deselected ? { deselected } : {}),
        });
      }
    }

    for (const [hook, template] of Object.entries(wiring.viteHooks ?? {})) {
      const line = fillInputPlaceholders(template, inputs);
      // A deselected artifact is planned with no hooks, so only a selected one, whose skill
      // directory is always known, reaches this loop.
      const problem = viteHookCommandProblem(line, /** @type {string} */ (artifact.skillDirectory));
      if (problem) {
        throw new Error(`${artifact.id} declares a ${hook} hook that Calavera refuses: ${problem}`);
      }
      const path = `.vite-hooks/${hook}`;
      const file = await current(path);
      const plan = planViteHookBlock({
        path,
        contents: file.contents,
        artifactId: artifact.id,
        line,
        recorded: previous?.viteHooks?.[hook],
      });
      if (plan.type === "conflict") {
        conflicts.push(/** @type {string} */ (plan.reason));
        continue;
      }
      file.contents = plan.contents;
      record.viteHooks = { ...record.viteHooks, [hook]: line };
      changes.push({
        artifact: artifact.id,
        path,
        kind: "vite-hook",
        type:
          plan.type === "unchanged"
            ? "unchanged"
            : file.original === undefined
              ? "write"
              : "update",
        block: line,
      });
    }

    // Groups apply recorded but the artifact no longer declares are planned against an empty
    // fragment, so they are removed rather than left running without a record.
    // A missing file holds none of them, so there is nothing to remove.
    const file =
      wiring.claudeCode || previous?.claudeCode ? await current(CLAUDE_SETTINGS_PATH) : undefined;
    if (file && (wiring.claudeCode || file.contents !== undefined)) {
      /** @type {unknown} */
      let fragment = { hooks: {} };
      if (wiring.claudeCode) {
        const fragmentPath = join(artifact.payloadDirectory, wiring.claudeCode);
        // The wiring comes from this CLI's catalog, and the fragment from the installed payload, so
        // an installed version older than the catalog can lack the file.
        const fragmentText = await readIfPresent(fragmentPath);
        if (fragmentText === undefined) {
          throw new Error(
            `${artifact.id} wires Claude Code with ${wiring.claudeCode}, but the installed payload in ${artifact.payloadDirectory} has no such file, so the installed version does not match this version of Calavera. Run create-project-calavera artifacts update ${artifact.id}, then run apply again.`,
          );
        }
        fragment = fillFragment(JSON.parse(fragmentText), inputs);
      }
      // Only a deselected artifact that neither the state record nor the catalog knows lacks one.
      if (artifact.skillDirectory === undefined) {
        throw new Error(
          `Calavera would remove the ${CLAUDE_SETTINGS_PATH} groups it recorded for ${artifact.id}, because the recipe no longer selects it, but neither the state record nor this version of Calavera says where ${artifact.id} was installed, so Calavera cannot tell its groups from yours. Run apply with a version of Calavera that knows ${artifact.id}, or remove the groups that run its scripts from ${CLAUDE_SETTINGS_PATH} and its entry from aiWiring in .calavera/state.json yourself.`,
        );
      }
      formatter ??= await loadFormatter();
      const plan = await planClaudeSettings({
        path: CLAUDE_SETTINGS_PATH,
        contents: file.contents,
        artifactId: artifact.id,
        fragment,
        recorded: previous?.claudeCode,
        skillDirectory: artifact.skillDirectory,
        formatter,
        deselected,
      });
      if (plan.type === "conflict") {
        conflicts.push(/** @type {string} */ (plan.reason));
      } else if (!(deselected && plan.type === "unchanged")) {
        // A deselected artifact whose groups are already gone has nothing to report.
        file.contents = plan.contents;
        // An artifact that no longer declares groups records none.
        if (plan.groups && Object.keys(plan.groups).length > 0) record.claudeCode = plan.groups;
        changes.push({
          artifact: artifact.id,
          path: CLAUDE_SETTINGS_PATH,
          kind: "claude-settings",
          type: plan.type,
          groupChanges: plan.changes,
          reformatted: plan.reformatted ?? false,
          ...(deselected ? { deselected } : {}),
        });
      }
    }

    // The wiring of a deselected artifact is gone after apply, and so is its record.
    if (!deselected) records.push(record);
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Calavera stopped before writing anything, because the wiring it would write or remove conflicts with the project:\n${conflicts.map((reason) => `- ${reason}`).join("\n")}`,
    );
  }

  return {
    // A file read only to find it missing, and left missing, is not part of the plan.
    files: [...files]
      .filter(([, { original, contents }]) => original !== undefined || contents !== undefined)
      .map(([path, { original, contents }]) => ({
        path,
        type: original === undefined ? "write" : contents === original ? "unchanged" : "update",
        contents: /** @type {string} */ (contents),
      })),
    changes,
    records,
  };
}

/**
 * Writes each planned wiring file that changes.
 *
 * @param {WiringFile[]} files
 * @param {string} [cwd]
 */
export async function writeArtifactWiring(files, cwd = process.cwd()) {
  for (const { path, type, contents } of files) {
    if (type === "unchanged") continue;
    const target = resolve(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

/**
 * The hook scripts in .vite-hooks and the Claude Code settings files that mention `artifactPath`,
 * with the text the planned wiring changes leave in them. Clean does not delete an artifact that
 * one of them still runs, recorded or not (#829): a block whose markers the person deleted to keep
 * it holds no record, but it fails as soon as its script is gone.
 *
 * A hook script kept through a symbolic link still runs, so the scan follows links, wherever they
 * point, and a hook that links to the artifact, or into its directory, counts as a mention. A link
 * that cannot be followed (its target is missing, runs through a file, or the links form a loop) is
 * listed in `unresolved`, because Calavera cannot read what it would run, and clean must keep the
 * artifact rather than read the link as mentioning nothing.
 *
 * The scan matches text, so it does not see a path that a script builds, such as through `cd`, a
 * glob, or a file the script sources. ADR-0015 records that limit.
 *
 * @param {string} artifactPath Relative to the project root: a skill directory, such as
 *   .agents/skills/protected-branch-guard, or a file, such as a hook script.
 * @param {WiringFile[]} plannedFiles The files as the planned wiring leaves them.
 * @param {string} [cwd]
 * @returns {Promise<{ mentions: string[], unresolved: string[] }>}
 */
export async function wiringFilesThatMention(artifactPath, plannedFiles, cwd = process.cwd()) {
  // The state records paths built with path.join, which uses backslashes on Windows, but scripts
  // and settings name them with slashes.
  const wanted = toSlashes(artifactPath);
  const artifactRealPath = await realpath(resolve(cwd, wanted)).catch(() => undefined);
  const entries = await readdir(resolve(cwd, ".vite-hooks"), { withFileTypes: true }).catch(
    (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
      throw error;
    },
  );
  // Sorted, because readdir's order depends on the file system. Each entry is checked below, so a
  // directory, such as the dispatcher in .vite-hooks/_, is skipped there.
  const hookPaths = entries.map(({ name }) => `.vite-hooks/${name}`).sort();
  /** @type {string[]} */
  const mentions = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const path of [...hookPaths, CLAUDE_SETTINGS_PATH, CLAUDE_LOCAL_SETTINGS_PATH]) {
    const planned = plannedFiles.find((file) => file.path === path);
    const read = planned
      ? { contents: planned.contents }
      : await readThroughLinks(resolve(cwd, path));
    if (read.unresolved) {
      unresolved.push(path);
      continue;
    }
    if (read.contents === undefined) continue;
    const linksIntoArtifact =
      artifactRealPath !== undefined &&
      read.realPath !== undefined &&
      (read.realPath === artifactRealPath || read.realPath.startsWith(`${artifactRealPath}${sep}`));
    const named = path.startsWith(".claude/")
      ? settingsMentionPath(read.contents, wanted)
      : mentionsPath(read.contents, wanted);
    if (linksIntoArtifact || named) mentions.push(path);
  }
  return { mentions, unresolved };
}

/** @param {string} path */
function toSlashes(path) {
  return path.replaceAll("\\", "/");
}

/**
 * Reads the regular file at `path`, following symbolic links, with the path it resolves to. A
 * missing file, a directory, a named pipe, or a device reads as no contents: Git runs only regular
 * files, and reading a pipe waits forever. A link that cannot be followed reads as unresolved.
 * Other errors propagate, which stops clean.
 *
 * @param {string} path
 * @returns {Promise<{ contents?: string, realPath?: string, unresolved?: true }>}
 */
async function readThroughLinks(path) {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    const { code } = /** @type {NodeJS.ErrnoException} */ (error);
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
    // lstat fails when nothing is at the path at all, which reads as a missing file.
    const link = await lstat(path).catch(() => undefined);
    return link?.isSymbolicLink() ? { unresolved: true } : {};
  }
  if (!stats.isFile()) return {};
  return { contents: await readFile(path, "utf8"), realPath: await realpath(path) };
}

/**
 * Whether a Claude Code settings file names `path`. JSON can spell the same path in more than one
 * way, such as with each slash escaped as \/, so each string value is checked as Claude Code reads
 * it, as well as the raw text. A file that is not JSON is searched as text only, because Claude
 * Code loads no settings from it.
 *
 * @param {string} text
 * @param {string} path
 */
function settingsMentionPath(text, path) {
  if (mentionsPath(text, path)) return true;
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return false;
  }
  return jsonStrings(settings).some((value) => mentionsPath(toSlashes(value), path));
}

/**
 * Every string in a parsed JSON value, keys included.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function jsonStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...jsonStrings(entry)]);
  }
  return [];
}

/**
 * Whether `text` names `path`: the path followed by the end of the text or by a character that
 * cannot continue a file name, such as a slash, a space, or a quote. A directory therefore matches
 * every path under it, and a file matches its own name but not a longer one that starts with it,
 * such as guard.mjs.bak or guard.mjsx.
 *
 * @param {string} text
 * @param {string} path
 */
function mentionsPath(text, path) {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const next = text.charAt(at + path.length);
    if (!/[\w.-]/.test(next)) return true;
  }
  return false;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What doctor reports about the wiring apply recorded: a block or group that is missing, one that
 * was edited, and a block whose script is missing, which makes Git refuse every commit or push.
 * Each finding names the file and the remedy, and the remedy depends on whether the recipe still
 * selects the artifact: apply writes the wiring of a selected artifact again, and removes the
 * wiring of a deselected one. Doctor only reads; it never changes a file.
 *
 * @param {object} options
 * @param {WiringRecord[]} options.records The aiWiring of the state record.
 * @param {Set<string>} options.selected The artifacts the recipe selects.
 * @param {(id: string) => string | undefined} options.skillDirectoryFor Where each artifact's skill is installed.
 * @param {string} [options.cwd]
 * @returns {Promise<WiringFinding[]>}
 */
export async function artifactWiringFindings({
  records,
  selected,
  skillDirectoryFor,
  cwd = process.cwd(),
}) {
  const apply = "create-project-calavera apply";
  /** @type {WiringFinding[]} */
  const findings = [];
  /** @param {string} message */
  const warn = (message) => findings.push({ level: "warning", message });

  for (const { artifact: id, viteHooks, claudeCode } of records) {
    const isSelected = selected.has(id);
    const deselectedNote = `the recipe no longer selects ${id}`;
    const directory = skillDirectoryFor(id);

    for (const [hook, recorded] of Object.entries(viteHooks ?? {})) {
      const path = `.vite-hooks/${hook}`;
      const contents = await readIfPresent(resolve(cwd, path));
      const block =
        contents === undefined
          ? /** @type {const} */ ({ found: false })
          : readViteHookBlock(path, contents, id);
      if ("reason" in block) {
        warn(block.reason);
      } else if (!block.found) {
        warn(
          isSelected
            ? `${path}: the ${id} block that Calavera recorded is missing, so Git does not run it. Run ${apply} to write it again; the dry run shows it first.`
            : `${path}: the ${id} block that Calavera recorded is missing, and ${deselectedNote}, so nothing needs to run there. Run ${apply} to drop the record.`,
        );
      } else if (block.text !== recorded) {
        warn(
          isSelected
            ? `${path}: the ${id} block was edited since Calavera wrote it, so the next apply stops with a conflict. Restore it to "${recorded}", or remove the block, both markers included, and run ${apply} to write it again.`
            : `${path}: the ${id} block was edited since Calavera wrote it, and ${deselectedNote}, so the next apply stops with a conflict instead of removing it. Restore it to "${recorded}" so apply removes it, or remove the block yourself, both markers included, or delete its markers to keep it as your own, and run ${apply}.`,
        );
      } else {
        // The state file can be edited by hand, so the recorded line is checked again before its
        // second word is read as a script path inside the skill directory.
        const problem =
          directory === undefined
            ? `doctor does not know where ${id} is installed`
            : viteHookCommandProblem(recorded, directory);
        const script = recorded.split(" ")[1];
        if (problem !== undefined) {
          warn(
            `${path}: the ${id} block holds what Calavera recorded, but the record is not a command Calavera writes: ${problem} Check the block and .calavera/state.json before you run ${apply}.`,
          );
        } else if (script !== undefined && !(await exists(resolve(cwd, script)))) {
          findings.push({
            level: "error",
            message: `${path}: the ${id} block runs ${script}, which does not exist, so the ${hook} hook fails and Git refuses every ${hook === "pre-push" ? "push" : "commit"}. ${isSelected ? await missingScriptRemedy(script, directory, apply, cwd) : `Because ${deselectedNote}, ${apply} removes the block; the dry run lists the removal first.`}`,
          });
        }
      }
    }

    if (!claudeCode) continue;
    const path = CLAUDE_SETTINGS_PATH;
    const contents = await readIfPresent(resolve(cwd, path));
    /** @type {Record<string, unknown>} */
    let hooks = {};
    if (contents !== undefined) {
      try {
        const settings = JSON.parse(contents);
        if (isObject(settings) && isObject(settings.hooks)) hooks = settings.hooks;
      } catch (error) {
        warn(
          `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}), so doctor cannot check the ${id} groups Calavera recorded there, and the next apply stops. Fix the JSON and run doctor again.`,
        );
        continue;
      }
    }
    for (const [event, groups] of Object.entries(claudeCode)) {
      const present = Array.isArray(hooks[event]) ? /** @type {unknown[]} */ (hooks[event]) : [];
      const recorded = Array.isArray(groups) ? groups : [];
      const missing = recorded.filter(
        (group) => !present.some((candidate) => isDeepStrictEqual(candidate, group)),
      );
      if (missing.length === 0) continue;
      // A group that runs the skill but matches no recorded group is the recorded one, edited.
      const edited =
        directory === undefined
          ? []
          : present.filter(
              (group) =>
                runsSkill(group, directory) &&
                !recorded.some((candidate) => isDeepStrictEqual(candidate, group)),
            );
      const wrote = JSON.stringify(missing[0]);
      if (edited.length > 0) {
        warn(
          isSelected
            ? `${path}: a ${event} group that runs ${directory}/ was edited since Calavera wrote it, so the next apply stops with a conflict. Restore it to ${wrote}, or remove that group, and run ${apply} to write it again.`
            : `${path}: a ${event} group that runs ${directory}/ was edited since Calavera wrote it, and ${deselectedNote}, so the next apply stops with a conflict instead of removing it. Restore it to ${wrote} so apply removes it, or remove that group yourself, and run ${apply}.`,
        );
      } else {
        warn(
          isSelected
            ? `${path}: the ${event} group for ${id} that Calavera recorded is missing, so Claude Code does not run it. Run ${apply} to add it again; the dry run shows it first.`
            : `${path}: the ${event} group for ${id} that Calavera recorded is missing, and ${deselectedNote}, so nothing needs to run there. Run ${apply} to drop the record.`,
        );
      }
    }
  }

  return findings;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string | undefined>} The trimmed output, or undefined when git exits non-zero.
 */
async function gitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") throw error;
    return undefined;
  }
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The remedy for a selected artifact's missing hook script. Apply installs the skill again only
 * when its folder is gone: a folder that is still there but no longer matches the hash Calavera
 * recorded counts as locally edited, and apply refuses to overwrite it. So with the folder still
 * there, the remedy restores the one script, which keeps the person's other changes.
 *
 * @param {string} script The missing script, relative to the project root.
 * @param {string | undefined} directory The skill folder, relative to the project root.
 * @param {string} apply The apply command.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function missingScriptRemedy(script, directory, apply, cwd) {
  if (directory === undefined || !(await exists(resolve(cwd, directory)))) {
    return `Run ${apply} to install the skill again.`;
  }
  return `${directory} is still there, so apply counts the missing file as a local edit and does not install the skill again. Restore the script with git checkout HEAD -- ${script}, which keeps any other changes in that folder. If the script was never committed, delete ${directory} and run ${apply} to install the skill again; that discards any other changes in that folder.`;
}

/**
 * The path with symbolic links resolved when it exists, so /var and /private/var on macOS, or a
 * symlinked home directory, compare equal; otherwise the path as given.
 *
 * @param {string} path
 */
async function canonical(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Explains, with the remedy, why Git would not run the scripts in .vite-hooks in this clone, or
 * returns undefined when the Vite+ hook dispatcher runs them. Paths are compared resolved, as Vite+
 * compares them, because core.hooksPath can be relative to the repository root or absolute.
 *
 * @param {string} cwd The project directory, which is the repository root (see gitHookArtifactIds).
 * @param {"managed" | "unmanaged" | "unknown"} vitePlusStatus
 * @param {string} wiredBy The artifacts that wire .vite-hooks, for the message.
 */
async function viteHooksProblem(cwd, vitePlusStatus, wiredBy) {
  const consequence = `and the hooks ${wiredBy} wires there will not run`;
  if (vitePlusStatus !== "managed") {
    return `This project does not use Vite+, and only the Vite+ hook dispatcher runs the scripts in .vite-hooks, ${consequence}.`;
  }
  const root = await gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) {
    return `${cwd} is not a Git repository, ${consequence}. Run git init, then vp config to install the Vite+ hook dispatcher.`;
  }
  if ((await gitOutput(cwd, ["config", "--get", "--type=bool", "vp.hooks.disabled"])) === "true") {
    return `Vite+ hooks are turned off in this clone (vp hooks disable), so Git runs none of the scripts in .vite-hooks, ${consequence}. Run vp hooks enable to turn them back on; vp config does not, because it keeps that choice.`;
  }
  const dispatcher = resolve(root, VITE_HOOKS_DISPATCHER);
  const hooksDirectory = await gitOutput(cwd, ["config", "--get", "vp.hooks.dir"]);
  if (
    hooksDirectory !== undefined &&
    (await canonical(resolve(root, hooksDirectory))) !== (await canonical(dirname(dispatcher)))
  ) {
    return `Vite+ runs the hook scripts in ${hooksDirectory} in this clone (vp.hooks.dir), not the ones in .vite-hooks, ${consequence}. Run vp hooks enable --hooks-dir .vite-hooks to use .vite-hooks; the scripts in ${hooksDirectory} then stop running.`;
  }
  const hooksPath = await gitOutput(cwd, ["config", "--get", "core.hooksPath"]);
  if (
    hooksPath !== undefined &&
    (await canonical(resolve(root, hooksPath))) !== (await canonical(dispatcher))
  ) {
    return `core.hooksPath is ${hooksPath}, so Git runs hooks from there instead of from the Vite+ hook dispatcher, ${consequence}. vp config leaves a different hooks path alone. To use the Vite+ dispatcher, remove that setting (git config --show-origin --get core.hooksPath shows where it is set), then run vp config.`;
  }
  if (hooksPath === undefined || !(await exists(dispatcher))) {
    return `The Vite+ hook dispatcher is not installed in this clone, so Git runs none of the scripts in .vite-hooks, ${consequence}. Run vp config to install it.`;
  }
  return undefined;
}

/**
 * Warnings for the dry run and apply about wiring that is written but would not act: Git hooks
 * that no dispatcher runs, and a protected branch that is the branch the applied files would be
 * committed on. Neither stops apply (owner ruling of 2026-10-31).
 *
 * @param {object} options
 * @param {{ ai?: unknown }} options.recipe The recipe with every input value filled in.
 * @param {"managed" | "unmanaged" | "unknown"} options.vitePlusStatus
 * @param {string} [options.cwd]
 * @param {(id: string) => ArtifactWiring | undefined} [options.wiringFor]
 * @param {(id: string) => Record<string, ArtifactInput> | undefined} [options.declarationsFor]
 * @returns {Promise<string[]>}
 */
export async function artifactWiringWarnings({
  recipe,
  vitePlusStatus,
  cwd = process.cwd(),
  wiringFor = catalogWiring,
  declarationsFor = catalogInputs,
}) {
  const selections = (Array.isArray(recipe.ai) ? recipe.ai : []).flatMap((item, index) =>
    item && typeof item === "object" && typeof item.id === "string"
      ? [{ id: /** @type {string} */ (item.id), index }]
      : [],
  );
  const hookIds = new Set(gitHookArtifactIds(recipe, wiringFor));
  const hookArtifacts = selections.filter(({ id }) => hookIds.has(id));
  if (hookArtifacts.length === 0) return [];

  /** @type {string[]} */
  const warnings = [];
  const problem = await viteHooksProblem(
    cwd,
    vitePlusStatus,
    hookArtifacts.map(({ id }) => id).join(", "),
  );
  if (problem) warnings.push(problem);

  const currentBranch = await gitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (currentBranch === undefined) return warnings;
  for (const { id, index } of hookArtifacts) {
    const inputs = recordedInputs(recipe, index);
    for (const [name, declaration] of Object.entries(declarationsFor(id) ?? {})) {
      if (declaration.check === "branch-name" && inputs[name] === currentBranch) {
        warnings.push(
          `You are on ${currentBranch}, the branch ${id} protects (${name}), so the guard will refuse to commit the applied files here. Create a feature branch first, for example with git switch -c <name>, and commit there.`,
        );
      }
    }
  }
  return warnings;
}
