// @ts-check
import { isNotEmptyString, isPlainObject } from "../utils/guards.js";
import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "./catalog.js";

const AI_SOURCE_DIRECTORIES = Object.freeze({
  skill: "skills",
  hook: "hooks",
  agent: "agents",
});

/**
 * @typedef {"skill" | "hook" | "agent"} AiArtifactType
 *
 * @typedef {object} AiItemConfig
 * @property {string} [id]
 * @property {string} [type]
 * @property {string} [src]
 * @property {string} [target]
 *
 * @typedef {object} NormalizedAiItem
 * @property {string} [id]
 * @property {AiArtifactType} type
 * @property {string} src
 * @property {string} [target]
 */

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
 * @param {unknown} value
 * @returns {value is AiItemConfig}
 */
function isAiItemConfig(value) {
  return (
    isPlainObject(value) &&
    ((isNotEmptyString(value.id) && value.type === undefined && value.src === undefined) ||
      (isNotEmptyString(value.type) && isNotEmptyString(value.src) && value.id === undefined)) &&
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

  const target = item.target?.trim() || DEFAULT_AI_TARGET;

  if (target.includes("/") || target.includes("\\") || target === "." || target === "..") {
    throw new Error(
      `AI item at index ${index} target must be a single directory name without path separators or traversal.`,
    );
  }

  return target;
}

/**
 * @param {string} src
 * @param {number} index
 * @param {AiArtifactType} type
 * @returns {(typeof aiArtifactCatalog)[number]}
 */
function validateAiSource(src, index, type) {
  const artifact = aiArtifactCatalog.find((candidate) => candidate.src === src);

  if (!artifact) {
    throw new Error(`AI item at index ${index} source must stay within src/ai/: ${src}.`);
  }

  if (artifact.type !== type) {
    throw new Error(
      `AI item at index ${index} ${type} source must be under ${AI_SOURCE_DIRECTORIES[type]}/: ${src}.`,
    );
  }

  return artifact;
}

/**
 * @param {unknown} aiConfig
 * @returns {NormalizedAiItem[]}
 */
export function normalizeAiItems(aiConfig) {
  if (aiConfig === undefined) {
    return [];
  }

  if (!Array.isArray(aiConfig)) {
    throw new Error("The optional ai config key must be an array.");
  }

  return aiConfig.map((entry, index) => {
    if (!isAiItemConfig(entry)) {
      throw new Error(`AI item at index ${index} must contain id, or legacy type and src fields.`);
    }

    let item;

    if (entry.id) {
      const artifact = aiArtifactCatalog.find(({ id }) => id === entry.id);
      if (!artifact) throw new Error(`AI item at index ${index} has unknown id "${entry.id}".`);
      item = {
        id: artifact.id,
        type: artifact.type,
        src: artifact.src,
        target: entry.target?.trim(),
      };
    } else {
      item = {
        type: /** @type {string} */ (entry.type).trim(),
        src: /** @type {string} */ (entry.src).trim(),
        target: entry.target?.trim(),
      };
    }

    const type = normalizeAiItemType(item.type, index);
    const target = normalizeAiTarget(type, item, index);
    const artifact = validateAiSource(item.src, index, type);

    if (
      item.target !== undefined &&
      artifact.targets &&
      (!target || !artifact.targets.includes(target))
    ) {
      throw new Error(
        `AI item at index ${index} target is not supported by ${item.id ?? item.src}.`,
      );
    }

    return {
      id: item.id,
      type,
      src: item.src,
      target,
    };
  });
}
