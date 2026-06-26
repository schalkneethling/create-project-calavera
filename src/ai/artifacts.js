// @ts-check
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { fileExists } from "../utils/fs.js";
import { isNotEmptyString, isPlainObject } from "../utils/guards.js";
import { hashDirectory, hashFile } from "../utils/hash.js";

/**
 * @typedef {import("../state.js").CalaveraState} CalaveraState
 *
 * @typedef {"skill" | "hook" | "agent"} AiArtifactType
 *
 * @typedef {object} AiItemConfig
 * @property {string} type
 * @property {string} src
 * @property {string} [target]
 *
 * @typedef {object} ResolvedAiArtifact
 * @property {number} index
 * @property {string} sourcePath
 * @property {string} source
 * @property {string} name
 * @property {AiArtifactType} type
 * @property {string} path
 * @property {string} [target]
 *
 * @typedef {object} AiArtifactState
 * @property {AiArtifactType} type
 * @property {string} name
 * @property {string} source
 * @property {string} path
 * @property {string} hash
 * @property {string} [target]
 *
 * @typedef {{ type: string, path: string, category?: "ai", aiType?: AiArtifactType, name?: string, reason?: string }} AiChange
 */

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const AI_SOURCE_ROOT = SOURCE_DIR;
const DEFAULT_AI_TARGET = "claude-code";

const AI_SOURCE_DIRECTORIES = Object.freeze({
  skill: "skills",
  hook: "hooks",
  agent: "agents",
});

/**
 * @param {string} type
 * @param {number} index
 * @returns {AiArtifactType}
 */
function normalizeAiItemType(type, index) {
  if (Object.hasOwn(AI_SOURCE_DIRECTORIES, type)) {
    return /** @type {AiArtifactType} */ (type);
  }

  throw new Error(
    `AI item at index ${index} has unsupported type "${type}". Supported types: skill, hook, agent.`,
  );
}

/**
 * @param {AiArtifactType} type
 * @returns {string}
 */
function sourceRootForAiType(type) {
  return join(AI_SOURCE_ROOT, AI_SOURCE_DIRECTORIES[type]);
}

/**
 * @param {unknown} value
 * @returns {value is AiItemConfig}
 */
function isAiItemConfig(value) {
  return (
    isPlainObject(value) &&
    isNotEmptyString(value.type) &&
    isNotEmptyString(value.src) &&
    (value.target === undefined || isNotEmptyString(value.target))
  );
}

/**
 * @param {AiArtifactType} type
 * @param {AiItemConfig} item
 * @param {number} index
 * @returns {string | undefined}
 */
function normalizeAiTarget(type, item, index) {
  if (type === "skill") {
    if (item.target !== undefined) {
      throw new Error(`AI item at index ${index} target only applies to hook and agent items.`);
    }

    return undefined;
  }

  return item.target?.trim() || DEFAULT_AI_TARGET;
}

/**
 * @param {unknown} aiConfig
 * @returns {AiItemConfig[]}
 */
function normalizeAiItems(aiConfig) {
  if (aiConfig === undefined) {
    return [];
  }

  if (!Array.isArray(aiConfig)) {
    throw new Error("The optional ai config key must be an array.");
  }

  return aiConfig.map((entry, index) => {
    if (!isAiItemConfig(entry)) {
      throw new Error(
        `AI item at index ${index} must be an object with non-empty type and src fields.`,
      );
    }

    return {
      type: entry.type.trim(),
      src: entry.src.trim(),
      target: entry.target?.trim(),
    };
  });
}

/**
 * @param {string} src
 * @param {number} index
 * @param {AiArtifactType} type
 * @returns {string}
 */
function resolveAiSourcePath(src, index, type) {
  const sourcePath = resolve(AI_SOURCE_ROOT, src);
  const sourceRoot = sourceRootForAiType(type);
  const relativeFromRoot = relative(AI_SOURCE_ROOT, sourcePath);
  const relativeFromTypeRoot = relative(sourceRoot, sourcePath);

  if (!relativeFromRoot || relativeFromRoot.startsWith("..") || isAbsolute(relativeFromRoot)) {
    throw new Error(`AI item at index ${index} source must stay within src/ai/: ${src}.`);
  }

  if (
    !relativeFromTypeRoot ||
    relativeFromTypeRoot.startsWith("..") ||
    isAbsolute(relativeFromTypeRoot)
  ) {
    throw new Error(
      `AI item at index ${index} ${type} source must be under ${relative(
        AI_SOURCE_ROOT,
        sourceRoot,
      )}/: ${src}.`,
    );
  }

  if (relativeFromTypeRoot.includes(sep)) {
    throw new Error(
      `AI item at index ${index} ${type} source must point to a top-level entry under ${relative(
        AI_SOURCE_ROOT,
        sourceRoot,
      )}/: ${relative(AI_SOURCE_ROOT, sourcePath)}.`,
    );
  }

  return sourcePath;
}

/**
 * @param {AiArtifactType} type
 * @param {string} sourcePath
 * @param {number} index
 * @returns {string}
 */
function inferAiSourceName(type, sourcePath, index) {
  if (type === "agent") {
    if (!sourcePath.endsWith(".md")) {
      throw new Error(
        `AI item at index ${index} agent source must point to a Markdown file: ${relative(
          AI_SOURCE_ROOT,
          sourcePath,
        )}.`,
      );
    }

    return basename(sourcePath, ".md");
  }

  return basename(sourcePath);
}

/**
 * @param {AiArtifactType} type
 * @param {string} name
 * @param {string | undefined} target
 * @returns {string}
 */
function aiInstallPath(type, name, target) {
  if (type === "skill") {
    return join(".agents", "skills", name);
  }

  if (!target) {
    throw new Error(`AI ${type} items require an output target.`);
  }

  if (type === "hook") {
    return join(".agents", "hooks", target, `${name}.mjs`);
  }

  return join(".agents", "agents", target, `${name}.md`);
}

/**
 * @param {AiArtifactType} type
 * @param {string} sourcePath
 * @param {number} index
 */
export async function assertAiSourceExists(type, sourcePath, index) {
  let sourceStats;

  try {
    sourceStats = await stat(sourcePath);
  } catch {
    throw new Error(
      `AI item at index ${index} references missing ${type} source: ${relative(
        AI_SOURCE_ROOT,
        sourcePath,
      )}.`,
    );
  }

  const isExpectedKind = type === "agent" ? sourceStats.isFile() : sourceStats.isDirectory();

  if (!isExpectedKind) {
    throw new Error(
      `AI item at index ${index} expected ${type} source "${relative(
        AI_SOURCE_ROOT,
        sourcePath,
      )}" to be a ${type === "agent" ? "file" : "directory"}.`,
    );
  }
}

/**
 * @param {AiArtifactType} type
 * @param {string} sourcePath
 * @returns {Promise<string>}
 */
async function hashAiSource(type, sourcePath) {
  if (type === "skill") {
    return hashDirectory(sourcePath);
  }

  if (type === "hook") {
    return hashFile(join(sourcePath, "hook.mjs"));
  }

  return hashFile(sourcePath);
}

/**
 * @param {AiArtifactType} type
 * @param {string} installPath
 * @returns {Promise<string>}
 */
export async function hashAiInstall(type, installPath) {
  if (type === "skill") {
    return hashDirectory(installPath);
  }

  return hashFile(installPath);
}

/**
 * @param {{ ai?: unknown }} recipe
 * @returns {ResolvedAiArtifact[]}
 */
export function resolveAiArtifacts(recipe) {
  /** @type {Map<string, ResolvedAiArtifact>} */
  const deduped = new Map();

  for (const [index, item] of normalizeAiItems(recipe.ai).entries()) {
    const type = normalizeAiItemType(item.type, index);
    const target = normalizeAiTarget(type, item, index);
    const sourcePath = resolveAiSourcePath(item.src, index, type);
    const name = inferAiSourceName(type, sourcePath, index);
    const key = [type, target, name].filter(Boolean).join(":");

    if (!deduped.has(key)) {
      deduped.set(key, {
        index,
        sourcePath,
        source: item.src,
        name,
        target,
        type,
        path: aiInstallPath(type, name, target),
      });
    }
  }

  return [...deduped.values()];
}

/**
 * @param {CalaveraState} state
 * @param {string} path
 * @returns {AiArtifactState | undefined}
 */
function stateAiArtifactForPath(state, path) {
  return state.aiArtifacts.find((artifact) => artifact.path === path);
}

/**
 * @param {ResolvedAiArtifact} artifact
 */
async function copyAiArtifact(artifact) {
  const installPath = resolve(artifact.path);

  if (artifact.type === "skill") {
    await mkdir(dirname(installPath), { recursive: true });
    await rm(installPath, { force: true, recursive: true });
    await cp(artifact.sourcePath, installPath, { recursive: true });
    return;
  }

  const sourcePath =
    artifact.type === "hook" ? join(artifact.sourcePath, "hook.mjs") : artifact.sourcePath;

  await mkdir(dirname(installPath), { recursive: true });
  await writeFile(installPath, await readFile(sourcePath));
}

/**
 * @param {ResolvedAiArtifact} artifact
 * @param {string} sourceHash
 * @param {CalaveraState} previousState
 */
async function assertSafeAiWrite(artifact, sourceHash, previousState) {
  if (!(await fileExists(artifact.path))) {
    return;
  }

  const installedHash = await hashAiInstall(artifact.type, artifact.path);

  if (installedHash === sourceHash) {
    return;
  }

  const stateArtifact = stateAiArtifactForPath(previousState, artifact.path);

  if (stateArtifact?.hash === installedHash) {
    return;
  }

  const reason = stateArtifact
    ? `It appears to have local edits (installed=${installedHash}, state=${stateArtifact.hash}).`
    : "It is not recorded as Calavera-managed.";

  throw new Error(`Refusing to overwrite existing AI artifact: ${artifact.path}. ${reason}`);
}

/**
 * @param {{ ai?: unknown }} recipe
 * @param {{ dryRun: boolean }} options
 * @param {CalaveraState} previousState
 * @returns {Promise<{ artifacts: AiArtifactState[], changes: AiChange[], pointers: string[] }>}
 */
export async function buildAiApplyResult(recipe, options, previousState) {
  const artifacts = resolveAiArtifacts(recipe);
  /** @type {AiChange[]} */
  const changes = [];
  /** @type {AiArtifactState[]} */
  const stateArtifacts = [];
  /** @type {Set<string>} */
  const pointerSet = new Set();

  for (const artifact of artifacts) {
    await assertAiSourceExists(artifact.type, artifact.sourcePath, artifact.index);
    const sourceHash = await hashAiSource(artifact.type, artifact.sourcePath);
    const stateArtifact = {
      type: artifact.type,
      name: artifact.name,
      source: artifact.source,
      target: artifact.target,
      path: artifact.path,
      hash: sourceHash,
    };

    stateArtifacts.push(stateArtifact);

    const upToDate =
      (await fileExists(artifact.path)) &&
      (await hashAiInstall(artifact.type, artifact.path)) === sourceHash;

    if (!upToDate) {
      await assertSafeAiWrite(artifact, sourceHash, previousState);
      changes.push({
        type: "write",
        path: artifact.path,
        category: "ai",
        aiType: artifact.type,
        name: artifact.name,
      });

      if (!options.dryRun) {
        await copyAiArtifact(artifact);
      }
    }

    if (artifact.type === "skill") {
      pointerSet.add("Installed skills are available under .agents/skills/.");
    }

    if (artifact.type === "hook") {
      pointerSet.add(
        `Hook scripts for ${artifact.target} are installed under .agents/hooks/${artifact.target}/. Review bundled settings-fragment.json files before wiring them into agent settings.`,
      );
    }

    if (artifact.type === "agent") {
      pointerSet.add(
        `Agent files for ${artifact.target} are installed under .agents/agents/${artifact.target}/ in their original Markdown/frontmatter format.`,
      );
    }
  }

  return {
    artifacts: stateArtifacts,
    changes,
    pointers: [...pointerSet],
  };
}
