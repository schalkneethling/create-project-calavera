// @ts-check
// #1176: the WebMCP specification does not have the browser check a tool's arguments against its
// inputSchema before it calls execute (https://webmachinelearning.github.io/webmcp/), so each
// Composer handler checks its own input against the schema it registers. The schemas are the JSON
// Schema forms the core generates from its shared tool definitions (ADR-0018, Decision 2), and the
// Composer keeps Zod out of its bundle, so this checker reads only the keywords that generator
// emits. It throws when it reaches any other keyword or type rather than skip a check it cannot
// run; test/tool-input.test.mjs checks that every keyword and type the generator emits is supported.

import { nodeOnlyInputMessage } from "../../packages/cli/src/recipe.js";

/** Keywords that describe a value without constraining it. */
const ANNOTATIONS = new Set(["description", "default"]);

/**
 * @typedef {(string | number)[]} InputPath
 * @typedef {{ path: InputPath, keyword: string, reason: string }} SchemaRefusal
 * @typedef {Record<string, unknown>} JsonSchema
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JSON Schema type of a value, with integer reported as number's subtype.
 *
 * @param {unknown} value
 * @param {string} type
 */
function hasType(value, type) {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "number":
      return Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    default:
      throw new Error(`The tool input checker does not support the JSON Schema type ${type}.`);
  }
}

/**
 * Formats a path the way the core names a field in its messages, such as aiArtifacts[0].inputs.
 *
 * @param {InputPath} path
 */
export function formatInputPath(path) {
  return path
    .map((key, index) => (typeof key === "number" ? `[${key}]` : index === 0 ? key : `.${key}`))
    .join("");
}

/**
 * The first part of `value` that `schema` refuses, or undefined when the schema accepts it.
 *
 * @param {JsonSchema} schema
 * @param {unknown} value
 * @param {InputPath} [path]
 * @returns {SchemaRefusal | undefined}
 */
export function schemaRefusal(schema, value, path = []) {
  /** @param {string} keyword @param {string} reason @param {InputPath} [at] */
  const refuse = (keyword, reason, at = path) => ({ path: at, keyword, reason });

  for (const [keyword, rule] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    switch (keyword) {
      case "type": {
        const types = /** @type {string[]} */ (Array.isArray(rule) ? rule : [rule]);
        if (!types.some((type) => hasType(value, type))) {
          const names = types.map((type) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`));
          return refuse(keyword, `expected ${names.join(" or ")}`);
        }
        break;
      }
      case "enum": {
        const values = /** @type {unknown[]} */ (rule);
        if (!values.includes(value)) {
          return refuse(keyword, `expected one of ${values.map(String).join(", ")}`);
        }
        break;
      }
      case "const":
        if (value !== rule) return refuse(keyword, `expected ${JSON.stringify(rule)}`);
        break;
      case "pattern":
        if (typeof value === "string" && !new RegExp(String(rule), "u").test(value)) {
          return refuse(keyword, "has a value in the wrong format");
        }
        break;
      case "minLength":
        if (typeof value === "string" && [...value].length < Number(rule)) {
          return refuse(keyword, `expected at least ${rule} characters`);
        }
        break;
      case "minimum":
        if (typeof value === "number" && value < Number(rule)) {
          return refuse(keyword, `expected a number of at least ${rule}`);
        }
        break;
      case "maximum":
        if (typeof value === "number" && value > Number(rule)) {
          return refuse(keyword, `expected a number of at most ${rule}`);
        }
        break;
      case "minItems":
        if (Array.isArray(value) && value.length < Number(rule)) {
          return refuse(keyword, `expected at least ${rule} ${rule === 1 ? "item" : "items"}`);
        }
        break;
      case "items":
        if (Array.isArray(value)) {
          for (const [index, item] of value.entries()) {
            const refusal = schemaRefusal(/** @type {JsonSchema} */ (rule), item, [...path, index]);
            if (refusal) return refusal;
          }
        }
        break;
      case "required":
        if (isPlainObject(value)) {
          const missing = /** @type {string[]} */ (rule).find((key) => !Object.hasOwn(value, key));
          if (missing !== undefined) return refuse(keyword, "is required", [...path, missing]);
        }
        break;
      case "properties":
        if (isPlainObject(value)) {
          const properties = /** @type {Record<string, JsonSchema>} */ (rule);
          for (const [key, propertySchema] of Object.entries(properties)) {
            if (!Object.hasOwn(value, key)) continue;
            const refusal = schemaRefusal(propertySchema, value[key], [...path, key]);
            if (refusal) return refusal;
          }
        }
        break;
      case "additionalProperties":
        if (isPlainObject(value)) {
          const known = /** @type {Record<string, JsonSchema>} */ (schema.properties ?? {});
          for (const key of Object.keys(value)) {
            if (Object.hasOwn(known, key)) continue;
            if (rule === false) return refuse(keyword, "is not a known field", [...path, key]);
            const refusal = schemaRefusal(/** @type {JsonSchema} */ (rule), value[key], [
              ...path,
              key,
            ]);
            if (refusal) return refusal;
          }
        }
        break;
      case "propertyNames":
        if (isPlainObject(value)) {
          for (const key of Object.keys(value)) {
            if (schemaRefusal(/** @type {JsonSchema} */ (rule), key)) {
              return refuse(keyword, "is not accepted here", [...path, key]);
            }
          }
        }
        break;
      case "not":
        if (!schemaRefusal(/** @type {JsonSchema} */ (rule), value)) {
          return refuse(keyword, "is not accepted here");
        }
        break;
      case "anyOf": {
        const refusals = [];
        for (const branch of /** @type {JsonSchema[]} */ (rule)) {
          const refusal = schemaRefusal(branch, value, path);
          if (!refusal) {
            refusals.length = 0;
            break;
          }
          refusals.push(refusal);
        }
        // Every branch refused. When each refused the value's type, the reason names every type.
        // Otherwise the branch that reached deepest into the value is the one the value was meant
        // for, such as the array branch of a list that may also be null.
        if (
          refusals.length > 0 &&
          refusals.every((refusal) => refusal.path === path && refusal.keyword === "type")
        ) {
          const types = refusals.map(({ reason }) => reason.slice("expected ".length));
          return refuse("type", `expected ${types.join(" or ")}`);
        }
        if (refusals.length > 0) {
          return refusals.reduce((deepest, refusal) =>
            refusal.path.length > deepest.path.length ? refusal : deepest,
          );
        }
        break;
      }
      default:
        throw new Error(
          `The tool input checker does not support the JSON Schema keyword ${keyword}.`,
        );
    }
  }
  return undefined;
}

/**
 * A tool input the handler refused before it called the core. `path` and `keyword` name the schema
 * rule that refused it, without the refused value; `cause` is the core's own error when the core
 * gave the message.
 */
export class ToolInputError extends Error {
  /**
   * @param {string} message
   * @param {{ path: string, keyword: string, cause?: unknown }} details
   */
  constructor(message, { path, keyword, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ToolInputError";
    this.path = path;
    this.keyword = keyword;
  }
}

/**
 * Returns `input` when `schema` accepts it. Otherwise it throws a ToolInputError whose message is
 * the core's: `coreCheck` runs the core's own check on the input, and its message wins, because it
 * names the fault with the core's remedy, as the MCP server's error maps do. The core checks the
 * whole input, so its message can name a different fault from the one at `path`; `path` and
 * `keyword` always name the schema rule. A part only Node.js can serve gets the core's message for
 * that, before the core's check runs. Any other refusal, where the core accepts more than
 * the schema, is described from the schema.
 *
 * @template T
 * @param {JsonSchema} schema The inputSchema the tool registers.
 * @param {T} input
 * @param {(input: T) => unknown} [coreCheck]
 * @returns {T}
 */
export function checkToolInput(schema, input, coreCheck) {
  const refusal = schemaRefusal(schema, input);
  if (!refusal) return input;

  const path = formatInputPath(refusal.path);
  // The core's generator marks a Node.js-only part by refusing its name with propertyNames. The
  // core accepts that part and checks its contents, so its message would describe a fault in a
  // field the agent must leave out; the Node.js-only message comes first.
  if (refusal.keyword === "propertyNames") {
    throw new ToolInputError(nodeOnlyInputMessage(path), { path, keyword: refusal.keyword });
  }
  try {
    // The core's checks read fields of an object; a refusal of the input itself has no core message.
    if (isPlainObject(input)) coreCheck?.(input);
  } catch (error) {
    if (error instanceof Error) {
      throw new ToolInputError(error.message, { path, keyword: refusal.keyword, cause: error });
    }
  }
  throw new ToolInputError(`Invalid ${path || "input"}: ${refusal.reason}.`, {
    path,
    keyword: refusal.keyword,
  });
}
