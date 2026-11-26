// @ts-check
import { dirname, relative, resolve } from "node:path";

import { parse } from "editorconfig";

import { isPathInside } from "./fs.js";

// Calavera formats the files it generates with the project's own `vp fmt` before it writes any of
// them (#669). Oxfmt reads some of its settings from the nearest `.editorconfig` at or above the
// working directory, so when apply also writes Calavera's `.editorconfig`, the settings `vp check`
// uses after apply can differ from the ones the formatter used before it. Calavera cannot format
// with a file that does not exist yet, so it compares the two and stops when they differ.

/**
 * The settings in the `.editorconfig` Calavera writes. It is a `root = true` file with one `[*]`
 * section, so these settings apply to every file in the project and nothing above the project
 * changes them.
 */
export const CALAVERA_EDITORCONFIG = Object.freeze({
  charset: "utf-8",
  end_of_line: "lf",
  insert_final_newline: true,
  indent_style: "space",
  indent_size: 2,
  trim_trailing_whitespace: true,
});

/**
 * @typedef {typeof CALAVERA_EDITORCONFIG} EditorConfigSettings
 */

/**
 * Returns the text of a `root = true` `.editorconfig` with `settings` in one `[*]` section.
 *
 * @param {Readonly<Record<string, string | number | boolean>>} settings
 * @returns {string}
 */
export function renderEditorConfig(settings) {
  const lines = Object.entries(settings).map(([key, value]) => `${key} = ${value}`);
  return `root = true\n\n[*]\n${lines.join("\n")}\n`;
}

/**
 * The `.editorconfig` properties Oxfmt reads, with the value Oxfmt uses when a property is
 * not set. Oxfmt's configuration schema names each one in its "Overrides `.editorconfig.…`" notes.
 */
const OXFMT_DEFAULTS = Object.freeze({
  indent_style: "space",
  indent_size: 2,
  end_of_line: "lf",
  insert_final_newline: true,
  max_line_length: 100,
  quote_type: "double",
});

/**
 * The value Oxfmt uses for each property it reads, given the properties that apply to a file.
 *
 * @param {Record<string, unknown>} properties
 * @returns {Record<keyof typeof OXFMT_DEFAULTS, unknown>}
 */
function oxfmtSettings(properties) {
  // Oxfmt reads indent_size and falls back to tab_width; indent_size = tab without a tab_width
  // leaves neither as a number.
  const indentSize =
    typeof properties.indent_size === "number"
      ? properties.indent_size
      : typeof properties.tab_width === "number"
        ? properties.tab_width
        : OXFMT_DEFAULTS.indent_size;
  return {
    indent_style: properties.indent_style ?? OXFMT_DEFAULTS.indent_style,
    indent_size: indentSize,
    end_of_line: properties.end_of_line ?? OXFMT_DEFAULTS.end_of_line,
    insert_final_newline: properties.insert_final_newline ?? OXFMT_DEFAULTS.insert_final_newline,
    max_line_length: properties.max_line_length ?? OXFMT_DEFAULTS.max_line_length,
    quote_type: properties.quote_type ?? OXFMT_DEFAULTS.quote_type,
  };
}

/**
 * The settings Oxfmt uses for `path`, and the `.editorconfig` files they come from.
 *
 * Oxfmt looks for `.editorconfig` from its working directory upward, which is the project root
 * here, and ignores files in subfolders, so this reads the same files: the project root's and its
 * parents', up to one marked `root = true`. Their sections match `path` as EditorConfig defines.
 * With `withoutProjectRootFile`, the project root's own file counts as missing, as it will once
 * clean removes it.
 *
 * @param {string} projectDirectory
 * @param {string} path The file path relative to the project root.
 * @param {{ withoutProjectRootFile?: boolean }} [options]
 */
async function oxfmtSettingsFor(projectDirectory, path, { withoutProjectRootFile = false } = {}) {
  /** @type {import("editorconfig").Visited[]} */
  const visited = [];
  const properties = await parse(resolve(projectDirectory, path), {
    unset: true,
    files: visited,
    cache: {
      // A subfolder's .editorconfig counts as missing, because Oxfmt never reads it.
      get(configPath) {
        const folder = dirname(configPath);
        if (!isPathInside(projectDirectory, folder)) return undefined;
        if (relative(projectDirectory, folder) === "" && !withoutProjectRootFile) return undefined;
        return { root: false, notfound: true, name: configPath, config: [[null, {}, null]] };
      },
      set() {
        return this;
      },
    },
  });
  return {
    settings: oxfmtSettings(properties),
    sources: [...new Set(visited.map(({ fileName }) => fileName))],
  };
}

/**
 * The first setting Oxfmt reads that differs between `now` and `after`, or undefined.
 *
 * @param {Record<keyof typeof OXFMT_DEFAULTS, unknown>} now
 * @param {Record<keyof typeof OXFMT_DEFAULTS, unknown>} after
 */
function firstSettingChange(now, after) {
  for (const property of /** @type {(keyof typeof OXFMT_DEFAULTS)[]} */ (
    Object.keys(OXFMT_DEFAULTS)
  )) {
    if (now[property] !== after[property]) {
      return { property, current: now[property], planned: after[property] };
    }
  }
  return undefined;
}

/**
 * Describes how writing `planned` as the project's `.editorconfig` would change the settings
 * Oxfmt uses for `path`, or returns undefined when it changes none of them. `sources` names the
 * files the current settings come from.
 *
 * @param {string} projectDirectory
 * @param {string} path The file path relative to the project root.
 * @param {EditorConfigSettings} planned
 * @returns {Promise<{ property: string, current: unknown, planned: unknown, sources: string[] } | undefined>}
 */
export async function editorConfigFormattingChange(projectDirectory, path, planned) {
  const now = await oxfmtSettingsFor(projectDirectory, path);
  const change = firstSettingChange(now.settings, oxfmtSettings(planned));
  return change && { ...change, sources: now.sources };
}

/**
 * Describes how removing the project root's `.editorconfig` would change the settings Oxfmt uses
 * for `path`, or returns undefined when it changes none of them. `sources` names the files the
 * settings come from after the removal.
 *
 * @param {string} projectDirectory
 * @param {string} path The file path relative to the project root.
 * @returns {Promise<{ property: string, current: unknown, planned: unknown, sources: string[] } | undefined>}
 */
export async function editorConfigRemovalChange(projectDirectory, path) {
  const now = await oxfmtSettingsFor(projectDirectory, path);
  const after = await oxfmtSettingsFor(projectDirectory, path, { withoutProjectRootFile: true });
  const change = firstSettingChange(now.settings, after.settings);
  return change && { ...change, sources: after.sources };
}
