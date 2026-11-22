// @ts-check
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { execa } from "execa";

import { detectVitePlus } from "../vite-plus-detection.js";
import {
  editorConfigFormattingChange,
  editorConfigRemovalChange,
  renderEditorConfig,
} from "./editorconfig.js";

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

/**
 * @typedef {object} FormatterOptions
 * @property {import("./editorconfig.js").EditorConfigSettings} [editorConfig] The `.editorconfig`
 *   the same run writes at the project root; formatting a file stops when that file would change
 *   the settings Oxfmt formats it with.
 * @property {boolean} [removesEditorConfig] Whether the same run removes the project root's
 *   `.editorconfig`, as clean does when the recipe drops editorconfig; formatting a file stops when
 *   the removal would change the settings Oxfmt formats it with (#838).
 * @property {string} [installDirectory] Where `vp install` installs the project's vite-plus, when
 *   that is not the project directory. Under `--manifest-choice create-here`, the project follows
 *   the Vite+ verdict of the manifest above it, so the remedy for a missing vite-plus names that
 *   manifest's directory (#1084).
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
 * @param {FormatterOptions & { timeout?: number }} [options]
 *   `timeout` is how long one vp fmt run may take, in milliseconds.
 * @returns {Promise<ProjectFormatter>}
 */
export async function loadProjectFormatter(
  projectDirectory,
  vitePlusStatus,
  { timeout = 60_000, editorConfig, removesEditorConfig = false, installDirectory } = {},
) {
  if (vitePlusStatus !== "managed") return unformatted;

  // vite-plus is the project's dependency, never the CLI's, so knip.json ignores it.
  const require = createRequire(join(projectDirectory, "package.json"));
  let manifestPath;
  try {
    manifestPath = require.resolve("vite-plus/package.json");
  } catch (error) {
    const install = installDirectory ? `vp install in ${installDirectory}` : "vp install";
    throw new Error(
      `${projectDirectory} uses Vite+, but Calavera cannot find its vite-plus package, so it cannot format the files it writes the way vp check expects. Run ${install}, then run Calavera again.`,
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
      if (editorConfig) {
        await assertEditorConfigKeepsSettings(projectDirectory, path, editorConfig);
      }
      if (removesEditorConfig) {
        await assertEditorConfigRemovalKeepsSettings(projectDirectory, path);
      }
      // vp is a Node script; Calavera's own Node runs it, so no shell or PATH lookup is involved.
      const result = await execa(process.execPath, [vp, "fmt", `--stdin-filepath=${path}`], {
        cwd: projectDirectory,
        input: text,
        reject: false,
        stripFinalNewline: false,
        // vp fmt runs the project's vite.config.ts, which could wait on something that never
        // completes; without a limit the dry run would hang with no message.
        timeout,
      });
      // #1157: neither error quotes vp fmt's output or keeps the result as its cause, because
      // vp fmt quotes the text it cannot parse, and vite.config.ts can print anything.
      if (result.timedOut) {
        throw new Error(
          `${description} did not finish formatting ${path} within ${timeout / 1000} seconds, so Calavera stopped it. Check that vite.config.ts does not wait on anything when vp fmt loads it, then run Calavera again.`,
        );
      }
      if (result.exitCode !== 0 || result.failed) {
        throw new Error(
          `${description} could not format ${path}: ${howItEnded(result)}. Calavera does not show vp fmt's output, because it can quote the file. Check that vite.config.ts loads without errors, which vp fmt --check in the project reports, then run Calavera again.`,
        );
      }
      return result.stdout;
    },
  };
}

/**
 * How a vp fmt run that did not succeed ended, from the fields of its execa result that hold no
 * output: whether its output outgrew the buffer, the signal, the exit code, or why it did not
 * start.
 *
 * @param {{ exitCode?: number, signal?: string, isMaxBuffer?: boolean, code?: string }} result
 */
export function howItEnded({ exitCode, signal, isMaxBuffer, code }) {
  // execa stops a process whose output outgrows the buffer itself, with SIGTERM.
  if (isMaxBuffer) return "its output outgrew the buffer, so Calavera stopped it";
  if (signal) return `it was stopped by the signal ${signal}`;
  if (exitCode !== undefined) return `it exited with code ${exitCode}`;
  return code ? `it did not start (${code})` : "it did not start";
}

/**
 * Returns a function that loads the formatter for the files Calavera writes in `directory` the
 * first time a file needs it, and the same formatter after that. Without `vitePlusStatus`, the
 * project is detected when the formatter loads.
 *
 * @param {string} directory
 * @param {"managed" | "unmanaged" | "unknown"} [vitePlusStatus]
 * @param {FormatterOptions} [options]
 * @returns {() => Promise<ProjectFormatter>}
 */
export function projectFormatterLoader(directory, vitePlusStatus, options = {}) {
  /** @type {Promise<ProjectFormatter> | undefined} */
  let formatter;
  return () =>
    (formatter ??= (async () =>
      loadProjectFormatter(
        directory,
        vitePlusStatus ?? (await detectVitePlus(directory)).status,
        options,
      ))());
}

/**
 * Stops when writing `editorConfig` would change the settings Oxfmt formats `path` with. The
 * formatted text would then fail `vp fmt --check` right after apply, and the next apply would
 * rewrite the file.
 *
 * @param {string} projectDirectory
 * @param {string} path
 * @param {import("./editorconfig.js").EditorConfigSettings} editorConfig
 */
async function assertEditorConfigKeepsSettings(projectDirectory, path, editorConfig) {
  const change = await editorConfigFormattingChange(projectDirectory, path, editorConfig);
  if (!change) return;
  const read =
    change.sources.length > 0
      ? `from ${change.sources.join(" and ")}`
      : "because no .editorconfig sets it";
  throw new Error(
    `Calavera's .editorconfig would change how vp fmt formats ${path}: ${change.property} is ${String(change.current)} now (${read}) and ${String(change.planned)} after apply. Calavera formats the files it writes before it writes any of them, so it cannot use settings that do not exist yet. Save this as .editorconfig in the project root, or leave editorconfig out of the recipe, then run Calavera again:\n\n${renderEditorConfig(editorConfig)}`,
  );
}

/**
 * Stops when removing the project root's `.editorconfig` would change the settings Oxfmt formats
 * `path` with. The formatted text would then fail `vp fmt --check` once the file is gone, and the
 * Vite+ pre-commit hook would rewrite it.
 *
 * @param {string} projectDirectory
 * @param {string} path
 */
async function assertEditorConfigRemovalKeepsSettings(projectDirectory, path) {
  const change = await editorConfigRemovalChange(projectDirectory, path);
  if (!change) return;
  const read =
    change.sources.length > 0
      ? `from ${change.sources.join(" and ")}`
      : "because no .editorconfig sets it";
  throw new Error(
    `Removing Calavera's .editorconfig would change how vp fmt formats ${path}: ${change.property} is ${String(change.current)} now and ${String(change.planned)} after clean (${read}). Calavera formats the files it writes before it changes anything, so it cannot use settings that apply only after clean. Delete .editorconfig yourself, or keep editorconfig in the recipe, then run clean again.`,
  );
}
