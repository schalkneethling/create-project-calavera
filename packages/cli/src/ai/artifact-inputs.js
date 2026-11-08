// @ts-check
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import { resolveDefaultBranch } from "../utils/default-branch.js";

const execFileAsync = promisify(execFile);

// Every input value can end up in a hook command that a shell runs, so a branch name is held to
// characters that are never special to the shell, even though Git also accepts `;`, `$`, or `|`.
const SHELL_SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * @typedef {import("@schalkneethling/calavera-artifact-core").ArtifactInput} ArtifactInput
 *
 * @typedef {(id: string) => Record<string, ArtifactInput> | undefined} InputDeclarations
 *
 * @typedef {object} InputRequest
 * @property {string} artifact The artifact ID.
 * @property {number} index The artifact's index in the recipe's ai list.
 * @property {string} name The input name, such as protectedBranch.
 * @property {string} prompt The question the artifact declares.
 * @property {string | undefined} defaultValue The suggested value, when one exists.
 * @property {string | undefined} error Why the last answer was refused, when it was.
 *
 * @typedef {(request: InputRequest) => Promise<string>} AskForInput
 *
 * @typedef {object} DefaultSource Which rule found the default, and what Git showed it.
 * @property {import("../utils/default-branch.js").DefaultBranchSource} rule
 * @property {string} detail
 *
 * @typedef {object} InputValue
 * @property {string} value
 * @property {"recorded" | "prompt" | "default"} source Where the value came from: the recipe, the person's answer, or the default because nobody was asked.
 * @property {DefaultSource} [defaultSource] Where the default came from, when the value is the default.
 *
 * @typedef {{ artifact: string, index: number, name: string } & InputValue} ResolvedInput
 *
 * @typedef {object} InputDescription
 * @property {string} prompt
 * @property {string} check
 * @property {string | null} recorded The value the recipe records, or null.
 * @property {string | null} default The value Calavera would use when none is recorded, or null.
 * @property {DefaultSource | null} defaultSource Where the default came from, or null.
 * @property {string | null} defaultUnavailable Why there is no default, or null.
 *
 * @typedef {{ artifact: string, index: number, name: string } & InputDescription} DescribedInput
 *
 * @typedef {object} InputSubject Who declares an input and where the recipe records its value.
 * @property {string} owner The artifact or integration ID.
 * @property {string} name The input name, such as protectedBranch.
 * @property {string} path Where the recipe records the value, such as ai[1].inputs.protectedBranch.
 *
 * @typedef {(request: { prompt: string, defaultValue: string | undefined, error: string | undefined }) => Promise<string>} AskForValue
 */

/** @type {InputDeclarations} */
function catalogDeclarations(id) {
  return artifactForId(id)?.inputs;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function commandFailure(error) {
  const stderr = /** @type {{ stderr?: unknown }} */ (error).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

/**
 * A missing Git would otherwise read as a refused branch name, and a prompt would refuse every
 * answer, so it stops resolution with its own message.
 *
 * @param {unknown} error
 * @param {string} purpose
 */
function assertGitFound(error, purpose) {
  if (/** @type {{ code?: unknown }} */ (error).code === "ENOENT") {
    throw new Error(
      `Calavera needs Git to ${purpose}, and git was not found on PATH. Install Git or add it to PATH, then run Calavera again.`,
      { cause: error },
    );
  }
}

/**
 * @param {ArtifactInput["default"]} kind
 * @param {string} cwd
 * @returns {Promise<{ value: string, defaultSource: DefaultSource } | { reason: string }>}
 */
async function readDefault(kind, cwd) {
  if (kind !== "repository-default-branch") {
    return { reason: "the artifact declares no default" };
  }

  try {
    const found = await resolveDefaultBranch(cwd);
    return "reason" in found
      ? found
      : { value: found.value, defaultSource: { rule: found.source, detail: found.detail } };
  } catch (error) {
    assertGitFound(error, "read the default");
    throw error;
  }
}

/**
 * @param {ArtifactInput["check"]} check
 * @param {string} value
 * @param {string} cwd
 * @returns {Promise<string | undefined>} Why the value is refused, or undefined when it passes.
 */
export async function checkInputValue(check, value, cwd) {
  if (check !== "branch-name") {
    return `Calavera does not know the check "${check}".`;
  }

  if (!SHELL_SAFE_BRANCH_NAME.test(value) || value.startsWith("-")) {
    return `"${value}" is not a branch name Calavera accepts. Use only letters, digits, ".", "_", "-", and "/", and do not start with "-", because Calavera writes the name into hook commands that a shell runs.`;
  }

  try {
    const { stdout } = await execFileAsync("git", ["check-ref-format", "--branch", value], { cwd });
    const normalized = stdout.trim();
    return normalized === value
      ? undefined
      : `"${value}" is not a plain branch name: git check-ref-format --branch reads it as "${normalized}".`;
  } catch (error) {
    assertGitFound(error, "check the input");
    return `"${value}" is not a valid branch name: git check-ref-format --branch refused it (${commandFailure(error)}).`;
  }
}

/**
 * @param {{ ai?: unknown }} recipe
 * @param {InputDeclarations} declarationsFor
 * @returns {{ item: Record<string, unknown>, index: number, id: string, declarations: Record<string, ArtifactInput> }[]}
 */
function itemsWithInputs(recipe, declarationsFor) {
  if (!Array.isArray(recipe.ai)) return [];

  return recipe.ai.flatMap((item, index) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string") return [];
    const declarations = declarationsFor(item.id);
    return declarations ? [{ item, index, id: item.id, declarations }] : [];
  });
}

/**
 * Describes one input for an agent: the recorded value, and the default with where it came from.
 *
 * @param {ArtifactInput} declaration
 * @param {string | undefined} recorded
 * @param {string} cwd
 * @returns {Promise<InputDescription>}
 */
export async function describeInputValue(declaration, recorded, cwd) {
  const fallback = await readDefault(declaration.default, cwd);
  return {
    prompt: declaration.prompt,
    check: declaration.check,
    recorded: recorded ?? null,
    default: "value" in fallback ? fallback.value : null,
    defaultSource: "value" in fallback ? fallback.defaultSource : null,
    defaultUnavailable: "reason" in fallback ? fallback.reason : null,
  };
}

/**
 * Reports each input the recipe's artifacts declare, with the recorded value and the default, so
 * an agent can confirm the value with the person before it runs dry_run_apply.
 *
 * @param {object} recipe
 * @param {{ cwd?: string, declarationsFor?: InputDeclarations }} [options]
 * @returns {Promise<DescribedInput[]>}
 */
export async function describeArtifactInputs(recipe, options = {}) {
  const { cwd = process.cwd(), declarationsFor = catalogDeclarations } = options;
  const { ai } = /** @type {{ ai?: unknown }} */ (recipe);
  /** @type {DescribedInput[]} */
  const described = [];

  for (const { item, index, id, declarations } of itemsWithInputs({ ai }, declarationsFor)) {
    const recorded = /** @type {Record<string, string> | undefined} */ (item.inputs);
    for (const [name, declaration] of Object.entries(declarations)) {
      described.push({
        artifact: id,
        index,
        name,
        ...(await describeInputValue(declaration, recorded?.[name], cwd)),
      });
    }
  }

  return described;
}

/**
 * Fills in one input and checks its value. A recorded value is kept. Otherwise `ask`, when given,
 * asks the person with the default suggested and asks again when the answer fails its check.
 * Without `ask`, the default is used and reported as such. With neither a recorded value nor a
 * default, resolution stops and names where the recipe records the value.
 *
 * @param {ArtifactInput} declaration
 * @param {string | undefined} recorded
 * @param {InputSubject} subject
 * @param {{ cwd: string, ask?: AskForValue }} options
 * @returns {Promise<InputValue>}
 */
export async function resolveInputValue(
  declaration,
  recorded,
  { owner, name, path },
  { cwd, ask },
) {
  if (recorded !== undefined) {
    const problem = await checkInputValue(declaration.check, recorded, cwd);
    if (problem) {
      throw new Error(
        `The recipe records ${name} for ${owner} (${path}), and Calavera refuses it: ${problem}`,
      );
    }
    return { value: recorded, source: "recorded" };
  }

  const fallback = await readDefault(declaration.default, cwd);
  const defaultValue = "value" in fallback ? fallback.value : undefined;

  if (ask) {
    /** @type {string | undefined} */
    let error;
    for (;;) {
      const answer = (await ask({ prompt: declaration.prompt, defaultValue, error })).trim();
      error = await checkInputValue(declaration.check, answer, cwd);
      if (!error) return { value: answer, source: "prompt" };
    }
  }

  if (!("value" in fallback)) {
    throw new Error(
      `${owner} needs the input ${name} ("${declaration.prompt}"), and the recipe records none. Calavera has no default because ${fallback.reason}. Record the value as ${path} in the recipe, then run apply again.`,
    );
  }

  const problem = await checkInputValue(declaration.check, fallback.value, cwd);
  if (problem) {
    throw new Error(
      `${owner} needs the input ${name}, and the recipe records none. The default Calavera found is refused: ${problem} Record the value as ${path} in the recipe, then run apply again.`,
    );
  }
  return { value: fallback.value, source: "default", defaultSource: fallback.defaultSource };
}

/**
 * Fills in every input the recipe's artifacts declare and checks each value, as
 * resolveInputValue describes.
 *
 * @template {object} R
 * @param {R} recipe
 * @param {{ cwd?: string, ask?: AskForInput, declarationsFor?: InputDeclarations }} [options]
 * @returns {Promise<{ recipe: R, inputs: ResolvedInput[] }>}
 */
export async function resolveArtifactInputs(recipe, options = {}) {
  const { cwd = process.cwd(), ask, declarationsFor = catalogDeclarations } = options;
  const { ai: selections } = /** @type {{ ai?: unknown }} */ (recipe);
  const items = itemsWithInputs({ ai: selections }, declarationsFor);
  if (items.length === 0) return { recipe, inputs: [] };

  /** @type {ResolvedInput[]} */
  const resolved = [];
  const ai = [.../** @type {unknown[]} */ (selections)];

  for (const { item, index, id, declarations } of items) {
    const recorded = /** @type {Record<string, string> | undefined} */ (item.inputs) ?? {};
    /** @type {Record<string, string>} */
    const values = { ...recorded };

    for (const [name, declaration] of Object.entries(declarations)) {
      const input = await resolveInputValue(
        declaration,
        recorded[name],
        { owner: id, name, path: `ai[${index}].inputs.${name}` },
        {
          cwd,
          ask: ask && ((request) => ask({ artifact: id, index, name, ...request })),
        },
      );
      values[name] = input.value;
      resolved.push({ artifact: id, index, name, ...input });
    }

    ai[index] = { ...item, inputs: values };
  }

  return { recipe: { ...recipe, ai }, inputs: resolved };
}
