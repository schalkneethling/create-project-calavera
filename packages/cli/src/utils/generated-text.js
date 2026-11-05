// @ts-check
import { writeJSON } from "./json-rewrite.js";

// The JSON and Markdown files Calavera generates pass through the project's formatter before the
// dry run, so a Vite+ project's `vp check` accepts them as written (#669). Nothing formats them
// after they are written: the comparison that decides whether a managed file is unchanged reads
// the bytes Calavera wrote.

/**
 * @typedef {import("./project-formatter.js").ProjectFormatter} ProjectFormatter
 */

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
  if (path.endsWith(".json")) {
    return writeJSON(JSON.parse(text), path, await loadFormatter());
  }

  if (path.endsWith(".md")) {
    const formatter = await loadFormatter();
    const formatted = await formatter.format(path, text);
    // Like writeJSON, a line that vite.config.ts prints arrives before the formatted text. Every
    // Markdown file Calavera generates starts with a line the formatter keeps as it is, a heading
    // or an HTML comment, so formatted text that starts differently holds something else.
    const firstLine = text.split("\n", 1)[0] ?? "";
    if (!formatted.startsWith(`${firstLine}\n`)) {
      const start = formatted.trimStart().split("\n", 1)[0]?.slice(0, 120) ?? "";
      throw new Error(
        `${formatter.description} returned text for ${path} that does not start with the line Calavera sent, "${firstLine}". It begins: "${start}". Make sure vite.config.ts prints nothing when vp fmt loads it, then run Calavera again.`,
      );
    }
    return formatted;
  }

  return text;
}
