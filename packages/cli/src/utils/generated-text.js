// @ts-check
import { CHANGED_CONTENT, PRINTS_NOTHING, writeJSON } from "./json-rewrite.js";
import { FormatterFailure } from "./formatter-failure.js";

// The JSON and Markdown files Calavera generates pass through the project's formatter before the
// dry run, so a Vite+ project's `vp check` accepts them as written (#669). Nothing formats them
// after they are written: the comparison that decides whether a managed file is unchanged reads
// the bytes Calavera wrote.

/**
 * @typedef {import("./project-formatter.js").ProjectFormatter} ProjectFormatter
 */

/** @type {ProjectFormatter} */
const unformatted = {
  description: "no formatter, because Calavera formats only generated files named .json or .md",
  format: async (_path, text) => text,
};

/**
 * Returns the formatter `formatGeneratedText` formats the JSON file at `path` with: the project's
 * for a name that ends in .json, and none for any other name, such as a recipe passed as
 * `--config recipe`. A check that asks how the file would be written, such as
 * `rewriteLossProblem`, uses this so it judges the text that is written (#1078).
 *
 * @param {string} path The file path relative to the project root.
 * @param {() => Promise<ProjectFormatter>} loadFormatter Called only for a .json name.
 * @returns {Promise<ProjectFormatter>}
 */
export async function generatedJSONFormatter(path, loadFormatter) {
  return isFormattedJSON(path) ? loadFormatter() : unformatted;
}

/** @param {string} path */
function isFormattedJSON(path) {
  return path.endsWith(".json");
}

/**
 * Returns the text Calavera writes for a file it generates. A JSON or Markdown file is formatted
 * by the project's formatter; any other file, such as `.editorconfig`, keeps `text`. Nothing is
 * written, so the dry run can show exactly this text.
 *
 * @param {string} path The file path relative to the project root, which picks the language.
 * @param {string} text The generated text. JSON must parse.
 * @param {() => Promise<ProjectFormatter>} loadFormatter Called only for JSON or Markdown, so a
 *   recipe that generates neither never loads the formatter.
 * @returns {Promise<string>}
 * @throws When the formatted text does not hold what Calavera generated.
 */
export async function formatGeneratedText(path, text, loadFormatter) {
  if (isFormattedJSON(path)) {
    return writeJSON(JSON.parse(text), path, await loadFormatter());
  }

  if (path.endsWith(".md")) {
    const formatter = await loadFormatter();
    const formatted = await formatter.format(path, text);
    // Like writeJSON, a line that vite.config.ts prints arrives before the formatted text. Every
    // Markdown file Calavera generates starts with a line the formatter keeps as it is, a heading
    // or an HTML comment, so formatted text that starts differently holds something else. Only the
    // line's text is compared, because a project whose .editorconfig sets end_of_line = crlf gets
    // that line back followed by "\r\n", not "\n".
    const firstLine = text.split("\n", 1)[0] ?? "";
    const formattedFirstLine = formatted.split(/\r?\n/, 1)[0];
    // #1157: neither error quotes a line, because either one can hold the file's text or
    // whatever vite.config.ts printed.
    if (formattedFirstLine !== firstLine) {
      throw new FormatterFailure(
        "printed-output",
        `${formatter.description} returned text for ${path} that does not start with the first line Calavera sent, so something came before the formatted text, such as output that vite.config.ts printed. ${PRINTS_NOTHING}`,
      );
    }
    if (formattedFirstLine.length === formatted.length) {
      throw new FormatterFailure(
        "changed-content",
        `${formatter.description} returned text for ${path} that ends after the first line, so it lost the rest of what Calavera sent. ${CHANGED_CONTENT}`,
      );
    }
    return formatted;
  }

  return text;
}
