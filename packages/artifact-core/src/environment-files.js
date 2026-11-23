// @ts-check
import { join } from "node:path";

import { readConfigText } from "./config-files.js";

// The environment files that a package manager or runtime loads into Calavera's environment
// before Calavera starts, and expands variables in: a Yarn 4 `.env.yarn` and the `.env` files Bun
// loads. Calavera cannot tell their values from the caller's, so it reads the files itself to find
// the values that came from a variable (#1186, owner decisions 2 and 3 of 2026-11-24).

// dotenv 16's line expression, as Yarn 4.18.1 bundles it for `injectEnvironmentFiles` (`parse` in
// dotenv lib/main.js). Bun 1.3.9 parses its `.env` files with its own parser; this expression
// reads the same keys and values for the files this module judges.
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * The entries of an environment file as dotenv's `parse` finds them: `KEY=value` or `KEY: value`,
 * with an optional `export`, a quoted value that may span lines, and `#` comments. Values keep
 * their quotes and are not expanded, because only whether they hold a variable reference matters
 * here, and Yarn and Bun expand inside quotes too.
 * @param {string} text
 */
export function parseEnvironmentFile(text) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  for (const match of text.replace(/\r\n?/g, "\n").matchAll(DOTENV_LINE)) {
    entries.set(/** @type {string} */ (match[1]), match[2] ?? "");
  }
  return entries;
}

/**
 * Yarn expands `${NAME}` and its fallback forms, and a backslash escapes the next `$`
 * (`$Q` in Yarn 4.18.1).
 * @param {string} value
 */
export function hasYarnReference(value) {
  return /(?<!\\)(?:\\\\)*\$\{/.test(value);
}

/**
 * Bun expands `$NAME` and `${NAME}`, in any quotes, also when NAME starts with a digit, and any
 * backslash before `$` keeps it literal (probed with Bun 1.3.9).
 * @param {string} value
 */
export function hasBunReference(value) {
  return /(?<!\\)\$(?:\{|\w)/.test(value);
}

/**
 * The variables whose value comes from a variable reference in `paths`, read in order so a later
 * file replaces an earlier one, mapped to the file that set them. A file that does not exist is
 * skipped; one that cannot be read is skipped with a warning that names its path and code.
 * @param {string[]} paths Lowest precedence first.
 * @param {(value: string) => boolean} hasReference
 * @param {string[]} warnings
 */
export async function variablesFromReferences(paths, hasReference, warnings) {
  /** @type {Map<string, string | undefined>} */
  const sources = new Map();
  for (const path of paths) {
    const text = await readConfigText(path, "environment file", warnings);
    if (text === undefined) continue;
    for (const [name, value] of parseEnvironmentFile(text)) {
      sources.set(name, hasReference(value) ? path : undefined);
    }
  }
  /** @type {Map<string, string>} */
  const claimed = new Map();
  for (const [name, path] of sources) if (path !== undefined) claimed.set(name, path);
  return claimed;
}

/**
 * The file of `paths` that defines each variable last, so a later file replaces an earlier one. A
 * file that does not exist or cannot be read is skipped; variablesFromReferences warns about the
 * second.
 * @param {string[]} paths Lowest precedence first.
 */
export async function environmentFileSources(paths) {
  /** @type {Map<string, string>} */
  const sources = new Map();
  for (const path of paths) {
    const text = await readConfigText(path, "environment file", []);
    if (text === undefined) continue;
    for (const name of parseEnvironmentFile(text).keys()) sources.set(name, path);
  }
  return sources;
}

/**
 * The chains of `.env` files that Bun 1.3.9 may have loaded from `cwd`, each lowest precedence
 * first: `.env`, `.env.<mode>`, `.env.local` (not under `NODE_ENV=test`), and `.env.<mode>.local`.
 * Bun chooses the mode from the caller's NODE_ENV before it loads the files: `production` or
 * `test`, and `development` otherwise. When a file of the mode's chain or of the development chain
 * defines NODE_ENV, the NODE_ENV in Calavera's environment may have come from it, which leaves
 * Bun's mode at `development`, so that chain is judged too.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} warnings
 */
export async function bunEnvironmentFileChains(cwd, env, warnings) {
  /** @param {string} mode */
  const chain = (mode) =>
    [".env", `.env.${mode}`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}.local`].map(
      (name) => join(cwd, name),
    );
  const mode =
    env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  if (mode === "development") return [chain(mode)];
  // A file of either chain may have set NODE_ENV: a development file, when the caller set none.
  for (const path of new Set([...chain(mode), ...chain("development")])) {
    const text = await readConfigText(path, "environment file", warnings);
    if (text !== undefined && parseEnvironmentFile(text).has("NODE_ENV")) {
      return [chain(mode), chain("development")];
    }
  }
  return [chain(mode)];
}
