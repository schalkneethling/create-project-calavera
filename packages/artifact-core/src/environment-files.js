// @ts-check
import { join, resolve } from "node:path";

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
 * Whether a value from an environment file may hold a variable: Yarn and Bun expand `${NAME}` (and
 * Bun `$NAME`), and both turn an escaped `\\${NAME}` into a literal `${NAME}`, which Calavera's
 * environment layer would expand from the caller's environment. Any `$` therefore counts.
 * @param {string} value
 */
export function mayHoldVariable(value) {
  return value.includes("$");
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
 * The file of `paths` that defines each variable last, so a later file replaces an earlier one,
 * with the value Bun gives it: without surrounding quotes, and with `\\n`, `\\r`, and `\\t` in a
 * double-quoted value turned into the characters they name (probed with Bun 1.3.9). A file that
 * does not exist or cannot be read is skipped; one that cannot be read adds a warning to
 * `unreadable`, which callers that do not report it leave empty and discard.
 * @param {string[]} paths Lowest precedence first.
 * @param {string[]} [unreadable]
 */
export async function environmentFileSources(paths, unreadable = []) {
  /** @type {Map<string, { path: string, value: string }>} */
  const sources = new Map();
  for (const path of paths) {
    const text = await readConfigText(path, "environment file", unreadable);
    if (text === undefined) continue;
    for (const [name, raw] of parseEnvironmentFile(text)) {
      const trimmed = raw.trim();
      const quote = /^(['"`])([\s\S]*)\1$/.exec(trimmed);
      const inner = quote?.[2] ?? trimmed;
      const value =
        quote?.[1] === '"'
          ? inner.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t")
          : inner;
      sources.set(name, { path, value });
    }
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
 * Bun also loads each file that an `--env-file` option of its own command line names, so those
 * files are a chain of their own.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} warnings
 * @param {string[]} execArgv Bun's options, as process.execArgv holds them.
 */
export async function bunEnvironmentFileChains(cwd, env, warnings, execArgv) {
  /** @param {string} mode */
  const chain = (mode) =>
    [".env", `.env.${mode}`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}.local`].map(
      (name) => join(cwd, name),
    );
  const mode =
    env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  /** @type {string[]} */
  const named = [];
  execArgv.forEach((option, index) => {
    const next = execArgv[index + 1];
    if (option.startsWith("--env-file=")) named.push(option.slice("--env-file=".length));
    else if (option === "--env-file" && next) named.push(next);
  });
  const extra = named.length > 0 ? [named.map((file) => resolve(cwd, file))] : [];
  if (mode === "development") return [chain(mode), ...extra];
  // A file of either chain may have set NODE_ENV: a development file, when the caller set none.
  for (const path of new Set([...chain(mode), ...chain("development")])) {
    const text = await readConfigText(path, "environment file", warnings);
    if (text !== undefined && parseEnvironmentFile(text).has("NODE_ENV")) {
      return [chain(mode), chain("development"), ...extra];
    }
  }
  return [chain(mode), ...extra];
}

/**
 * Which of `names` a `.env` file that Bun may have loaded defines, mapped to that file, and whether
 * one of the files exists but could not be read, in which case any of `names` may come from it.
 * Bun keeps a variable that the caller, such as npm starting Bun, already set, so a file value
 * that differs from the one in `env` is not where that value came from; a value with a `$` may
 * have been expanded from the caller's environment, so it counts in any case (#1186).
 * @param {string[][]} chains From bunEnvironmentFileChains.
 * @param {NodeJS.ProcessEnv} env
 * @param {readonly string[]} names
 * @returns {Promise<{ fromFile: Map<string, string>, unreadable: boolean }>}
 */
export async function variablesFromBunFiles(chains, env, names) {
  /** @type {Map<string, string>} */
  const fromFile = new Map();
  /** @type {string[]} */
  const unreadable = [];
  for (const chain of chains) {
    for (const [name, { path, value }] of await environmentFileSources(chain, unreadable)) {
      if (names.includes(name) && (value === env[name] || mayHoldVariable(value))) {
        fromFile.set(name, path);
      }
    }
  }
  return { fromFile, unreadable: unreadable.length > 0 };
}
