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
 * @param {string} artifactId
 */
function markers(artifactId) {
  return {
    start: `# calavera:${artifactId}:start`,
    end: `# calavera:${artifactId}:end`,
  };
}

/**
 * @typedef {object} FoundBlock
 * @property {string[]} lines The script's lines, each with its own carriage return, if any.
 * @property {string} cr "\r" when the script uses Windows line endings, so added lines match.
 * @property {number} startIndex The start marker's line, or -1 when the script has no block.
 * @property {number} endIndex The end marker's line, or -1 when the script has no block.
 * @property {string} current The text between the markers, without carriage returns.
 */

/**
 * Finds this artifact's block in a script, or explains why its markers cannot be trusted.
 *
 * @param {string} path
 * @param {string} contents
 * @param {string} artifactId
 * @returns {FoundBlock | { reason: string }}
 */
function findBlock(path, contents, artifactId) {
  const { start, end } = markers(artifactId);
  // Lines keep their own endings. A script with Windows line endings gets them on the lines
  // Calavera adds too, and every comparison ignores the carriage return.
  const cr = contents.includes("\r\n") ? "\r" : "";
  const lines = contents.split("\n");
  const bare = lines.map((text) => text.replace(/\r$/, ""));
  const indexes = (/** @type {string} */ marker) =>
    bare.flatMap((text, index) => (text.trimEnd() === marker ? [index] : []));
  const starts = indexes(start);
  const ends = indexes(end);

  // A line that names this block but is not exactly a marker is one the person changed, such as
  // an indented block inside an `if`. Inserting a second block would defeat their change.
  const changedMarker = bare.find(
    (text) =>
      (text.includes(`calavera:${artifactId}:start`) ||
        text.includes(`calavera:${artifactId}:end`)) &&
      text.trimEnd() !== start &&
      text.trimEnd() !== end,
  );
  if (changedMarker !== undefined) {
    return {
      reason: `${path}: a marker line was changed: "${changedMarker}". Calavera only recognizes "${start}" and "${end}" as whole lines. Restore them, or remove the block, both markers included, and run apply again.`,
    };
  }

  if (starts.length === 0 && ends.length === 0) {
    return { lines, cr, startIndex: -1, endIndex: -1, current: "" };
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
      reason: `${path}: the Calavera block for ${artifactId} ${markerProblem}, so Calavera cannot tell where its block ends. Make the file hold exactly one "${start}" line followed later by one "${end}" line, or remove both markers and the lines between them, and run apply again.`,
    };
  }

  const startIndex = /** @type {number} */ (starts[0]);
  const endIndex = /** @type {number} */ (ends[0]);
  return {
    lines,
    cr,
    startIndex,
    endIndex,
    current: bare.slice(startIndex + 1, endIndex).join("\n"),
  };
}

/** @param {string} text */
function indent(text) {
  return text
    .split("\n")
    .map((row) => `  ${row}`)
    .join("\n");
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
 * Plans the removal of a block apply wrote for a hook the artifact no longer wires. The block goes,
 * markers included, only while it still holds what apply wrote; an edited block is a conflict, so
 * a change the person made is never deleted silently.
 *
 * @param {object} options
 * @param {string} options.path
 * @param {string | undefined} options.contents
 * @param {string} options.artifactId
 * @param {string} options.recorded The command line apply wrote last, from the state record.
 * @returns {{ type: "update" | "unchanged" | "conflict", contents?: string, reason?: string }}
 */
export function planViteHookBlockRemoval({ path, contents, artifactId, recorded }) {
  if (contents === undefined) return { type: "unchanged" };
  const found = findBlock(path, contents, artifactId);
  if ("reason" in found) return { type: "conflict", reason: found.reason };
  const { lines, startIndex, endIndex, current } = found;
  if (startIndex === -1) return { type: "unchanged", contents };
  if (current !== recorded) {
    return {
      type: "conflict",
      reason: `${path}: ${artifactId} no longer wires this hook, so Calavera would remove its block, but the block was edited since Calavera wrote it.\nCalavera wrote:\n${indent(recorded)}\nThe file now holds:\n${indent(current)}\nRemove the block yourself, both markers included, or keep it and delete its markers, and run apply again.`,
    };
  }
  return {
    type: "update",
    contents: [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)].join("\n"),
  };
}
