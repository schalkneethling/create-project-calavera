// @ts-check

// ADR-0015, Decision 5: apply owns one marked block in each project-owned .vite-hooks script and
// never touches a line outside it. Vite+ owns the dispatcher under .vite-hooks/_ and runs each
// script with `sh -e`, so a block placed first stops the commit before `vp staged` runs.

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
    const value = inputs[name];
    if (value === undefined) {
      const declared = Object.keys(inputs);
      throw new Error(
        `${placeholder} names no input of this artifact; ${declared.length === 0 ? "it declares no inputs" : `it declares ${declared.join(", ")}`}.`,
      );
    }
    return value;
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
  const prefix = `${skillDirectory}/`;
  if (program !== "node" || !script?.startsWith(prefix) || script.length === prefix.length) {
    return `"${command}" must start with "node ${prefix}" followed by a script in that directory.`;
  }
  if (script.split("/").some((segment) => segment === "." || segment === "..")) {
    return `"${command}" must not use ".." or "." in the script path.`;
  }
  const option = args.find((arg) => arg.startsWith("-"));
  if (option !== undefined) {
    return `"${command}" passes "${option}", and an argument must not start with "-".`;
  }
  return undefined;
}

/**
 * @param {string} artifactId
 */
function markers(artifactId) {
  return {
    start: `# calavera:${artifactId}:start`,
    end: `# calavera:${artifactId}:end`,
  };
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
  const { start, end } = markers(artifactId);
  const block = `${start}\n${line}\n${end}`;
  if (contents === undefined) {
    return { type: "write", contents: `${block}\n`, block: line };
  }

  const lines = contents.split("\n");
  const indexes = (/** @type {string} */ marker) =>
    lines.flatMap((text, index) => (text.trimEnd() === marker ? [index] : []));
  const starts = indexes(start);
  const ends = indexes(end);

  if (starts.length === 0 && ends.length === 0) {
    const shebang = lines[0]?.startsWith("#!") ? 1 : 0;
    const rest = lines.slice(shebang).join("\n");
    const head = lines
      .slice(0, shebang)
      .map((text) => `${text}\n`)
      .join("");
    return {
      type: "update",
      contents: `${head}${block}\n${rest}`,
      block: line,
    };
  }

  const markerProblem =
    starts.length === 1 && ends.length === 0
      ? "has a start marker without an end marker"
      : starts.length === 0 && ends.length === 1
        ? "has an end marker without a start marker"
        : starts.length !== 1 || ends.length !== 1
          ? `has ${starts.length} start marker${starts.length === 1 ? "" : "s"} and ${ends.length} end marker${ends.length === 1 ? "" : "s"}`
          : /** @type {number} */ (ends[0]) < /** @type {number} */ (starts[0])
            ? "has an end marker that comes before its start marker"
            : undefined;
  if (markerProblem !== undefined) {
    return {
      type: "conflict",
      block: line,
      reason: `${path}: the Calavera block for ${artifactId} ${markerProblem}, so Calavera cannot tell where its block ends. Make the file hold exactly one "${start}" line followed later by one "${end}" line, or remove both markers and the lines between them, and run apply again.`,
    };
  }

  const startIndex = /** @type {number} */ (starts[0]);
  const endIndex = /** @type {number} */ (ends[0]);
  const current = lines.slice(startIndex + 1, endIndex).join("\n");
  if (current === line) {
    return { type: "unchanged", contents, block: line };
  }
  if (recorded !== undefined && current === recorded) {
    return {
      type: "update",
      contents: [...lines.slice(0, startIndex + 1), line, ...lines.slice(endIndex)].join("\n"),
      block: line,
    };
  }

  const indent = (/** @type {string} */ text) =>
    text
      .split("\n")
      .map((row) => `  ${row}`)
      .join("\n");
  return {
    type: "conflict",
    block: line,
    previousBlock: current,
    reason: `${path}: the Calavera block for ${artifactId} ${recorded === undefined ? "is already in the file, and Calavera has no record of writing it" : "was edited since Calavera wrote it"}.${recorded === undefined ? "" : `\nCalavera wrote:\n${indent(recorded)}\n`}The file now holds:\n${indent(current)}\nCalavera would write:\n${indent(line)}\nTo let Calavera write it, remove the block, both markers included, and run apply again.`,
  };
}
