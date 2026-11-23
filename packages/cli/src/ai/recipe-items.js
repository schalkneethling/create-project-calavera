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
 * @property {Record<string, unknown>} [inputs]
 *
 * @typedef {object} NormalizedAiItem
 * @property {string} [id] The ID the entry names, absent for a legacy entry.
 * @property {string} catalogId The ID of the catalog artifact the entry selects, whether it names an
 *   ID or a legacy type and src (#1119).
 * @property {AiArtifactType} type
 * @property {string} src
 * @property {string} [target]
 * @property {Record<string, string>} [inputs]
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
    (value.target === undefined || isNotEmptyString(value.target)) &&
    // Only a package-backed selection can record inputs, because only the catalog declares them.
    (value.inputs === undefined || (value.id !== undefined && isPlainObject(value.inputs)))
  );
}

/**
 * Checks recorded input values against the inputs the artifact declares. A value's own check,
 * such as a valid branch name, needs Git and runs when the CLI resolves the inputs.
 *
 * @param {Record<string, unknown> | undefined} inputs
 * @param {(typeof aiArtifactCatalog)[number]} artifact
 * @param {number} index
 * @returns {Record<string, string> | undefined}
 */
function normalizeAiItemInputs(inputs, artifact, index) {
  if (inputs === undefined) {
    return undefined;
  }

  const entries = Object.entries(inputs);

  if (entries.length === 0) {
    throw new Error(`AI item at index ${index} inputs must record at least one value.`);
  }

  for (const [name, value] of entries) {
    if (!Object.hasOwn(artifact.inputs ?? {}, name)) {
      throw new Error(
        `AI item at index ${index} sets input "${name}", which ${artifact.id} does not declare.`,
      );
    }

    if (!isNotEmptyString(value)) {
      throw new Error(`AI item at index ${index} input "${name}" must be a non-empty string.`);
    }
  }

  return /** @type {Record<string, string>} */ ({ ...inputs });
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

  // #1137: the src is text from the person's file, so the message names the entry by its position
  // instead of repeating it. A src outside the catalog, inside src/ai/ or not, is unknown.
  if (!artifact) {
    throw new Error(
      `AI item at index ${index} (ai[${index}]) names a legacy src that Calavera does not know. Remove the item from ai, or replace it with an id entry that the list_ai_artifacts MCP tool lists.`,
    );
  }

  if (artifact.type !== type) {
    throw new Error(
      `AI item at index ${index} ${type} source must be under ${AI_SOURCE_DIRECTORIES[type]}/: ${src}.`,
    );
  }

  return artifact;
}

/**
 * Throws when the artifact declares the targets it supports and `target` is not one of them.
 * Composing and validating a recipe both call this, so a composed recipe always validates (#1077).
 *
 * @param {(typeof aiArtifactCatalog)[number]} artifact
 * @param {string | undefined} target
 * @param {number} index
 * @param {string} name The ID or source the entry names.
 */
export function assertSupportedTarget(artifact, target, index, name) {
  if (artifact.targets && !artifact.targets.includes(/** @type {string} */ (target))) {
    throw new Error(`AI item at index ${index} target is not supported by ${name}.`);
  }
}

/**
 * Records the first index at which an artifact ID is selected and throws on a second selection.
 * The lock, the outputs, and the transaction are all keyed by artifact ID, so a second selection
 * cannot be installed whatever its target is.
 *
 * @param {Map<string, number>} firstIndexById
 * @param {string} id
 * @param {number} index
 */
export function assertFirstSelection(firstIndexById, id, index) {
  const firstIndex = firstIndexById.get(id);
  if (firstIndex !== undefined) {
    throw new Error(
      `Duplicate artifact id "${id}" at AI item indexes ${firstIndex} and ${index}. Select each artifact once.`,
    );
  }
  firstIndexById.set(id, index);
}

/**
 * #1125, owner decision of 2026-11-21: apply refuses a legacy entry, such as
 * `{ "type": "skill", "src": "skills/protected-branch-guard" }`, that selects an artifact that
 * declares wiring or inputs, because a legacy entry cannot record the inputs and Calavera does not
 * guess them. `artifacts migrate` rewrites each legacy entry as an ID entry. Apply, update,
 * `artifacts install` and `artifacts update` (#1137), their dry runs, and the MCP apply tools call
 * this before they plan or write anything. Clean still reads a legacy entry; doctor reports the
 * refusal with `legacyEntryWiringRefusal` (#1140).
 *
 * @param {unknown} aiConfig
 */
export function assertNoLegacyEntryNeedsWiring(aiConfig) {
  const refusal = legacyEntryWiringRefusal(aiConfig, "Calavera stopped before writing anything");
  if (refusal !== undefined) throw new Error(refusal);
}

/**
 * The message apply's legacy-entry refusal raises (#1125), or undefined when apply would not
 * refuse. doctor reports the same entries and remedy (#1140), so the rule and its remedy live in
 * one place. Only the outcome differs: apply stopped, while doctor says that apply stops.
 *
 * @param {unknown} aiConfig
 * @param {string} outcome What the refusal means for this command, such as "apply stops before writing anything".
 * @returns {string | undefined}
 */
export function legacyEntryWiringRefusal(aiConfig, outcome) {
  const refused = normalizeAiItems(aiConfig).flatMap((item, index) => {
    if (item.id !== undefined) return [];
    const artifact = /** @type {(typeof aiArtifactCatalog)[number]} */ (
      aiArtifactCatalog.find(({ id }) => id === item.catalogId)
    );
    const needs = [artifact.wiring ? "wiring" : undefined, artifact.inputs ? "inputs" : undefined]
      .filter(Boolean)
      .join(" and ");
    if (needs === "") return [];
    // Only the validated type and src are named, not the person's raw entry.
    const entry = JSON.stringify({ type: item.type, src: item.src });
    return [
      `- ai[${index}] ${entry} selects ${artifact.id} by its legacy type and src, and ${artifact.id} needs ${needs}, which a legacy entry cannot record.`,
    ];
  });
  if (refused.length === 0) return undefined;
  return [
    `${outcome}, because these legacy AI entries select artifacts that need wiring or inputs:`,
    ...refused,
    "Run create-project-calavera artifacts migrate, which rewrites each legacy entry as an ID entry, then apply the recipe again. Apply in a terminal asks for each input value the recipe does not record; any other run names where the recipe must record it.",
  ].join("\n");
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

  /** @type {Map<string, number>} */
  const firstIndexById = new Map();

  return aiConfig.map((entry, index) => {
    if (!isAiItemConfig(entry)) {
      throw new Error(`AI item at index ${index} must contain id, or legacy type and src fields.`);
    }

    let item;

    if (entry.id) {
      const artifact = aiArtifactCatalog.find(({ id }) => id === entry.id);
      // #1137: the id is text from the person's file, so the message names the entry by its
      // position instead of repeating it.
      if (!artifact) {
        throw new Error(
          `AI item at index ${index} (ai[${index}]) names an artifact ID that Calavera does not know. Remove the item from ai, or replace its id with an artifact ID that the list_ai_artifacts MCP tool lists.`,
        );
      }
      item = {
        id: artifact.id,
        type: artifact.type,
        src: artifact.src,
        target: entry.target?.trim(),
        inputs: normalizeAiItemInputs(entry.inputs, artifact, index),
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

    assertFirstSelection(firstIndexById, artifact.id, index);

    assertSupportedTarget(artifact, target, index, item.id ?? item.src);

    return {
      id: item.id,
      catalogId: artifact.id,
      type,
      src: item.src,
      target,
      ...(item.inputs ? { inputs: item.inputs } : {}),
    };
  });
}
