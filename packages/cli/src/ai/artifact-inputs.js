// @ts-check
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

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
 * @typedef {object} ResolvedInput
 * @property {string} artifact
 * @property {number} index
 * @property {string} name
 * @property {string} value
 * @property {"recorded" | "prompt" | "default"} source Where the value came from: the recipe, the person's answer, or the default because nobody was asked.
 *
 * @typedef {object} DescribedInput
 * @property {string} artifact
 * @property {number} index
 * @property {string} name
 * @property {string} prompt
 * @property {string} check
 * @property {string | null} recorded The value the recipe records, or null.
 * @property {string | null} default The value Calavera would use when none is recorded, or null.
 * @property {string | null} defaultUnavailable Why there is no default, or null.
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
 * @param {ArtifactInput["default"]} kind
 * @param {string} cwd
 * @returns {Promise<{ value: string } | { reason: string }>}
 */
async function readDefault(kind, cwd) {
  if (kind !== "current-branch") {
    return { reason: "the artifact declares no default" };
  }

  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
    });
    return { value: stdout.trim() };
  } catch (error) {
    // With --quiet, a detached HEAD exits 1 and prints nothing; anything else is a Git failure.
    const code = /** @type {{ code?: unknown }} */ (error).code;
    const failure = commandFailure(error);
    return code === 1 && !(/** @type {{ stderr?: string }} */ (error).stderr?.trim())
      ? { reason: "HEAD is detached, so there is no current branch" }
      : { reason: `git symbolic-ref --short HEAD failed: ${failure}` };
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
      const fallback = await readDefault(declaration.default, cwd);
      described.push({
        artifact: id,
        index,
        name,
        prompt: declaration.prompt,
        check: declaration.check,
        recorded: recorded?.[name] ?? null,
        default: "value" in fallback ? fallback.value : null,
        defaultUnavailable: "reason" in fallback ? fallback.reason : null,
      });
    }
  }

  return described;
}

/**
 * Fills in every input the recipe's artifacts declare and checks each value. A recorded value is
 * kept. Otherwise `ask`, when given, asks the person with the default suggested and asks again
 * when the answer fails its check. Without `ask`, the default is used and reported as such. With
 * neither a recorded value nor a default, resolution stops and names the missing input.
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
      const recordedValue = recorded[name];
      if (recordedValue !== undefined) {
        const problem = await checkInputValue(declaration.check, recordedValue, cwd);
        if (problem) {
          throw new Error(
            `The recipe records ${name} for ${id} (ai[${index}].inputs.${name}), and Calavera refuses it: ${problem}`,
          );
        }
        resolved.push({ artifact: id, index, name, value: recordedValue, source: "recorded" });
        continue;
      }

      const fallback = await readDefault(declaration.default, cwd);
      const defaultValue = "value" in fallback ? fallback.value : undefined;

      if (ask) {
        /** @type {string | undefined} */
        let error;
        for (;;) {
          const answer = (
            await ask({
              artifact: id,
              index,
              name,
              prompt: declaration.prompt,
              defaultValue,
              error,
            })
          ).trim();
          error = await checkInputValue(declaration.check, answer, cwd);
          if (!error) {
            values[name] = answer;
            resolved.push({ artifact: id, index, name, value: answer, source: "prompt" });
            break;
          }
        }
        continue;
      }

      if (defaultValue === undefined) {
        throw new Error(
          `${id} needs the input ${name} ("${declaration.prompt}"), and the recipe records none. Calavera has no default because ${"reason" in fallback ? fallback.reason : "none is declared"}. Record the value as ai[${index}].inputs.${name} in the recipe, then run apply again.`,
        );
      }

      const problem = await checkInputValue(declaration.check, defaultValue, cwd);
      if (problem) {
        throw new Error(
          `${id} needs the input ${name}, and the recipe records none. The default Calavera found is refused: ${problem} Record the value as ai[${index}].inputs.${name} in the recipe, then run apply again.`,
        );
      }
      values[name] = defaultValue;
      resolved.push({ artifact: id, index, name, value: defaultValue, source: "default" });
    }

    ai[index] = { ...item, inputs: values };
  }

  return { recipe: { ...recipe, ai }, inputs: resolved };
}
