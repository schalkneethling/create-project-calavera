// @ts-check
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { execa } from "execa";

// A file Calavera writes into a Vite+ project must already be in the shape `vp check` expects, or
// the project fails its own check right after apply (#669). Formatting it after the write would
// change bytes the dry run never showed, so Calavera formats in memory, before the dry run: it
// passes the text through the project's own `vp fmt --stdin-filepath`, which prints the formatted
// text and writes nothing. Vite+ then applies what `vp check` applies: the project's Oxfmt version,
// the `fmt` settings in vite.config.ts, .editorconfig, and the ignore patterns. Oxfmt's `format`
// function, which `vite-plus/fmt` exports, reads none of those settings.

/**
 * @typedef {object} ProjectFormatter
 * @property {string} description Names the formatter for diagnostics, such as "vp fmt from vite-plus 1.4.0".
 * @property {(path: string, text: string) => Promise<string>} format Formats `text` as the file at
 *   `path`, relative to the project root. The path decides the language and which settings and
 *   ignore patterns apply, so one formatter handles JSON and Markdown alike; a file type Oxfmt
 *   does not support is an error. It never writes the file.
 */

/** @type {ProjectFormatter} */
const unformatted = {
  description: "no formatter, because the project does not use Vite+",
  format: async (_path, text) => text,
};

/**
 * Loads the formatter for the files Calavera writes into a project. A Vite+ project gets the `vp`
 * its own `vite-plus` dependency provides, and loading stops with a remedy when that dependency is
 * not installed. Any other project gets its text back unchanged, because no Oxfmt check runs there.
 *
 * @param {string} projectDirectory
 * @param {"managed" | "unmanaged" | "unknown"} vitePlusStatus From detectVitePlus. Only "managed" counts as a Vite+ project.
 * @returns {Promise<ProjectFormatter>}
 */
export async function loadProjectFormatter(projectDirectory, vitePlusStatus) {
  if (vitePlusStatus !== "managed") return unformatted;

  // vite-plus is the project's dependency, never the CLI's, so knip.json ignores it.
  const require = createRequire(join(projectDirectory, "package.json"));
  let manifestPath;
  try {
    manifestPath = require.resolve("vite-plus/package.json");
  } catch (error) {
    throw new Error(
      `${projectDirectory} uses Vite+, but Calavera cannot find its vite-plus package, so it cannot format the files it writes the way vp check expects. Run vp install, then run Calavera again.`,
      { cause: error },
    );
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const name = `vite-plus ${manifest.version}`;
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vp;
  if (typeof bin !== "string") {
    throw new Error(
      `${name} in ${dirname(manifestPath)} has no vp command, so Calavera cannot format the files it writes the way vp check expects. Run vp install, then run Calavera again.`,
    );
  }
  const vp = join(dirname(manifestPath), bin);

  const description = `vp fmt from ${name}`;
  return {
    description,
    async format(path, text) {
      // vp is a Node script; Calavera's own Node runs it, so no shell or PATH lookup is involved.
      const result = await execa(process.execPath, [vp, "fmt", `--stdin-filepath=${path}`], {
        cwd: projectDirectory,
        input: text,
        reject: false,
        stripFinalNewline: false,
      });
      if (result.exitCode !== 0 || result.failed) {
        throw new Error(
          `${description} could not format ${path} (exit code ${result.exitCode ?? "none"}):\n${result.stderr || result.stdout || result.message}`,
          { cause: result },
        );
      }
      return result.stdout;
    },
  };
}
