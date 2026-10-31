// @ts-check
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import { planClaudeSettings } from "./claude-settings.js";
import {
  fillInputPlaceholders,
  planViteHookBlock,
  planViteHookBlockRemoval,
  viteHookCommandProblem,
} from "./vite-hook-blocks.js";

const execFileAsync = promisify(execFile);

// ADR-0015, Decisions 4 and 5: a skill's manifest can wire the installed skill into the project's
// .vite-hooks scripts and .claude/settings.json. Apply plans the wiring of every selected artifact
// before it writes anything, so a conflict in any file stops apply with nothing written, and the
// dry run shows the exact lines and groups that apply then writes.

const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
// The directory `vp config` installs the dispatcher into when the hooks directory is .vite-hooks,
// and the value it sets core.hooksPath to (node_modules/vite-plus/docs/guide/commit-hooks.md).
const VITE_HOOKS_DISPATCHER = ".vite-hooks/_";

/**
 * @typedef {import("@schalkneethling/calavera-artifact-core").ArtifactWiring} ArtifactWiring
 * @typedef {import("@schalkneethling/calavera-artifact-core").ArtifactInput} ArtifactInput
 * @typedef {import("./claude-settings.js").HookGroups} HookGroups
 * @typedef {import("./claude-settings.js").HookGroupChange} HookGroupChange
 * @typedef {import("../utils/project-formatter.js").ProjectFormatter} ProjectFormatter
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
 * @property {string} [removedBlock] The command line of a block apply removes, because the artifact no longer wires that hook.
 * @property {HookGroupChange[]} [groupChanges] The groups added, replaced, or removed, for a claude-settings change.
 * @property {boolean} [reformatted] Whether rewriting .claude/settings.json also changes the layout of text outside the groups.
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
 * Plans the wiring of every selected artifact. Artifacts are planned in recipe order, and each one
 * plans against the text the one before it left, so two artifacts that wire the same file both
 * land in it. Any conflict stops the plan, after every file has been checked, so the error lists
 * each one.
 *
 * @param {object} options
 * @param {{ ai?: unknown }} options.recipe The recipe with every input value filled in.
 * @param {WiredArtifact[]} options.artifacts
 * @param {WiringRecord[]} options.previousRecords From the state record.
 * @param {() => Promise<ProjectFormatter>} options.loadFormatter Called only when an artifact wires .claude/settings.json.
 * @param {string} [options.cwd]
 * @param {(id: string) => ArtifactWiring | undefined} [options.wiringFor]
 * @returns {Promise<{ files: WiringFile[], changes: WiringChange[], records: WiringRecord[] }>}
 */
export async function planArtifactWiring({
  recipe,
  artifacts,
  previousRecords,
  loadFormatter,
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

  for (const artifact of artifacts) {
    const wiring = wiringFor(artifact.id);
    if (!wiring) continue;
    const inputs = recordedInputs(recipe, artifact.index);
    const previous = previousRecords.find((record) => record.artifact === artifact.id);
    /** @type {WiringRecord} */
    const record = { artifact: artifact.id };

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
        });
      }
    }

    for (const [hook, template] of Object.entries(wiring.viteHooks ?? {})) {
      const line = fillInputPlaceholders(template, inputs);
      const problem = viteHookCommandProblem(line, artifact.skillDirectory);
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
      const fragment = fillFragment(JSON.parse(fragmentText), inputs);
      const file = await current(CLAUDE_SETTINGS_PATH);
      formatter ??= await loadFormatter();
      const plan = await planClaudeSettings({
        path: CLAUDE_SETTINGS_PATH,
        contents: file.contents,
        artifactId: artifact.id,
        fragment,
        recorded: previous?.claudeCode,
        skillDirectory: artifact.skillDirectory,
        formatter,
      });
      if (plan.type === "conflict") {
        conflicts.push(/** @type {string} */ (plan.reason));
      } else {
        file.contents = plan.contents;
        record.claudeCode = plan.groups;
        changes.push({
          artifact: artifact.id,
          path: CLAUDE_SETTINGS_PATH,
          kind: "claude-settings",
          type: plan.type,
          groupChanges: plan.changes,
          reformatted: plan.reformatted ?? false,
        });
      }
    }

    records.push(record);
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Calavera stopped before writing anything, because the wiring it would write conflicts with the project:\n${conflicts.map((reason) => `- ${reason}`).join("\n")}`,
    );
  }

  return {
    files: [...files].map(([path, { original, contents }]) => ({
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
