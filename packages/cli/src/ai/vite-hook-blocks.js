// @ts-check

// ADR-0015, Decision 5: apply owns one marked block in each project-owned .vite-hooks script and
// never touches a line outside it. Vite+ owns the dispatcher under .vite-hooks/_ and runs each
// script with `sh -e`, so a block placed first stops the commit before `vp staged` runs.

import { findBlock, indent, markers } from "../utils/marked-block.js";

// Placeholder names follow the input names the artifact manifest schema allows.
const PLACEHOLDER = /\{\{([a-z][A-Za-z0-9]*)\}\}/g;
// Every token of a hook command is held to characters a shell never treats as special, so the
// command runs as written, whatever the inputs held.
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9._/-]+$/;

/**
 * @typedef {object} ViteHookBlockPlan
 * @property {"write" | "update" | "unchanged" | "conflict"} type
 * @property {string} block The command line apply places between the markers.
 * @property {string} [contents] The script text after apply, unless the plan is a conflict.
 * @property {string} [previousBlock] The text between the markers now, when it is a conflict.
 * @property {string} [reason] Why apply stops, when it is a conflict.
 */

/**
 * Replaces each `{{name}}` with the recorded value of the input `name`.
 *
 * @param {string} template
 * @param {Record<string, string>} inputs
 * @returns {string}
 */
export function fillInputPlaceholders(template, inputs) {
  const filled = template.replace(PLACEHOLDER, (placeholder, /** @type {string} */ name) => {
    // Object.hasOwn, so {{toString}} is not filled from Object.prototype.
    if (!Object.hasOwn(inputs, name)) {
      const recorded = Object.keys(inputs);
      throw new Error(
        `${placeholder} has no recorded value; ${recorded.length === 0 ? "no inputs are recorded for this artifact" : `the recorded inputs are ${recorded.join(", ")}`}.`,
      );
    }
    return /** @type {string} */ (inputs[name]);
  });
  if (filled.includes("{{") || filled.includes("}}")) {
    throw new Error(
      `"${template}" has a malformed placeholder. Write a placeholder as {{inputName}}, with no spaces.`,
    );
  }
  return filled;
}

/**
 * Returns why `command` may not go into a hook script, or undefined when it may. A command runs a
 * script from the artifact's own skill directory with `node`, and every token is shell-safe.
 *
 * @param {string} command
 * @param {string} skillDirectory The installed skill directory, such as .agents/skills/protected-branch-guard.
 * @returns {string | undefined}
 */
export function viteHookCommandProblem(command, skillDirectory) {
  const tokens = command.split(" ");
  if (tokens.some((token) => token === "")) {
    return `"${command}" must separate its words with single spaces.`;
  }
  const unsafe = tokens.find((token) => !SHELL_SAFE_TOKEN.test(token));
  if (unsafe !== undefined) {
    return `"${command}" may hold only letters, digits, ".", "_", "-", and "/" in each word, and "${unsafe}" does not.`;
  }
  const [program, script, ...args] = tokens;
  const prefix = `${skillDirectory.replace(/\/+$/, "")}/`;
  if (program !== "node" || !script?.startsWith(prefix) || script.length === prefix.length) {
    return `"${command}" must start with "node ${prefix}" followed by a script in that directory.`;
  }
  const segments = script.slice(prefix.length).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `"${command}" must not use ".." or "." in the script path.`;
  }
  if (segments.includes("")) {
    return `"${command}" has an empty path segment in the script path.`;
  }
  if (!/\.(?:mjs|cjs|js)$/.test(script)) {
    return `"${command}" must name a script ending in .mjs, .cjs, or .js.`;
  }
  const option = args.find((arg) => arg.startsWith("-"));
  if (option !== undefined) {
    return `"${command}" passes "${option}", and an argument must not start with "-".`;
  }
  return undefined;
}

/**
 * Plans apply's block in one .vite-hooks script. Without the script, apply writes the block alone.
 * Without the block, apply inserts it first, after a `#!` line. With the block, apply replaces it
 * only when it still holds what apply wrote last; an edited block or a broken marker pair is a
 * conflict, and apply writes nothing.
 *
 * @param {object} options
 * @param {string} options.path The script path to name in a conflict, such as .vite-hooks/pre-commit.
 * @param {string | undefined} options.contents The script text now, or undefined when it does not exist.
 * @param {string} options.artifactId
 * @param {string} options.line The command line to place, with its placeholders filled.
 * @param {string | undefined} options.recorded The command line apply wrote last, from the state record.
 * @returns {ViteHookBlockPlan}
 */
export function planViteHookBlock({ path, contents, artifactId, line, recorded }) {
  if (/[\r\n]/.test(line)) {
    throw new Error(`The ${artifactId} command for ${path} must be a single line.`);
  }
  const { start, end } = markers(artifactId);
  if (contents === undefined) {
    return { type: "write", contents: `${start}\n${line}\n${end}\n`, block: line };
  }

  const found = findBlock(path, contents, artifactId);
  if ("reason" in found) {
    return { type: "conflict", block: line, reason: found.reason };
  }
  const { lines, cr, startIndex, endIndex, current } = found;
  const blockLines = [start, line, end].map((text) => `${text}${cr}`);

  if (startIndex === -1) {
    const shebang = lines[0]?.startsWith("#!") ? 1 : 0;
    const head = lines.slice(0, shebang).map((text) => `${text}\n`);
    const rest = lines.slice(shebang).join("\n");
    return {
      type: "update",
      contents: `${head.join("")}${blockLines.join("\n")}\n${rest}`,
      block: line,
    };
  }

  if (current === line) {
    return { type: "unchanged", contents, block: line };
  }
  if (recorded !== undefined && current === recorded) {
    return {
      type: "update",
      contents: [
        ...lines.slice(0, startIndex + 1),
        /** @type {string} */ (blockLines[1]),
        ...lines.slice(endIndex),
      ].join("\n"),
      block: line,
    };
  }

  return {
    type: "conflict",
    block: line,
    previousBlock: current,
    reason: `${path}: the Calavera block for ${artifactId} ${recorded === undefined ? "is already in the file, and Calavera has no record of writing it" : "was edited since Calavera wrote it"}.\n${recorded === undefined ? "" : `Calavera wrote:\n${indent(recorded)}\n`}The file now holds:\n${indent(current)}\nCalavera would write:\n${indent(line)}\nTo let Calavera write it, remove the block, both markers included, and run apply again.`,
  };
}

/**
 * The text of this artifact's block in a script, for a check that only reads, such as doctor.
 * `found` is false when the script holds no block, and `reason` explains a broken marker pair.
 *
 * @param {string} path
 * @param {string} contents
 * @param {string} artifactId
 * @returns {{ found: false } | { found: true, text: string } | { reason: string }}
 */
export function readViteHookBlock(path, contents, artifactId) {
  const block = findBlock(path, contents, artifactId);
  if ("reason" in block) return { reason: block.reason };
  return block.startIndex === -1 ? { found: false } : { found: true, text: block.current };
}

/**
 * Plans the removal of a block apply wrote, because the artifact no longer wires the hook or the
 * recipe no longer selects the artifact. The block goes, markers included, only while it still
 * holds what apply wrote; an edited block is a conflict, so a change the person made is never
 * deleted silently.
 *
 * @param {object} options
 * @param {string} options.path
 * @param {string | undefined} options.contents
 * @param {string} options.artifactId
 * @param {string} options.recorded The command line apply wrote last, from the state record.
 * @param {string} [options.because] Why the block goes, which a conflict message names.
 * @returns {{ type: "update" | "unchanged" | "conflict", contents?: string, reason?: string }}
 */
export function planViteHookBlockRemoval({
  path,
  contents,
  artifactId,
  recorded,
  because = `${artifactId} no longer wires this hook`,
}) {
  if (contents === undefined) return { type: "unchanged" };
  const found = findBlock(path, contents, artifactId);
  if ("reason" in found) return { type: "conflict", reason: found.reason };
  const { lines, startIndex, endIndex, current } = found;
  if (startIndex === -1) return { type: "unchanged", contents };
  if (current !== recorded) {
    return {
      type: "conflict",
      reason: `${path}: ${because}, so Calavera would remove its block, but the block was edited since Calavera wrote it.\nCalavera wrote:\n${indent(recorded)}\nThe file now holds:\n${indent(current)}\nRemove the block yourself, both markers included, or keep it and delete its markers, and run apply again.`,
    };
  }
  return {
    type: "update",
    contents: [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)].join("\n"),
  };
}
