// @ts-check
// The bin entries load this module before the CLI, on whatever Node.js the user
// runs, so it must load on versions below the supported range too: it imports
// only Node.js built-ins, reads package.json without import attributes, and
// uses no syntax newer than the first Node.js releases with ES modules (no
// top-level await, nullish coalescing, or optional chaining).
import { createRequire } from "node:module";
import { inspect } from "node:util";

/**
 * The Node.js range the CLI supports, read from `engines.node` in package.json.
 * It tracks the Vite+ 1.0.0 floor that `--new` relies on (#626).
 *
 * @type {string}
 */
export const NODE_ENGINE_RANGE = createRequire(import.meta.url)("../package.json").engines.node;

/**
 * Whether a Node.js version satisfies `NODE_ENGINE_RANGE`. The three ranges are
 * compared by hand because the CLI does not depend on a semver parser; a test
 * checks this function against `engines.node` with semver for release versions.
 *
 * Only the major and minor numbers count, so a prerelease such as a nightly or
 * a release candidate is accepted when its line is supported (for example
 * `v26.0.0-rc.1` or `v24.12.0-nightly20260101abcdef`), although semver ranges
 * exclude prereleases. Those builds are how people test upcoming Node.js
 * releases, and refusing them would block that testing for no benefit.
 *
 * @param {string} version `process.version`, with or without the leading `v`.
 * @returns {boolean}
 */
export function nodeSatisfiesEngineRange(version) {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);

  return (major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major >= 26;
}

/**
 * Starts a bin entry on a supported Node.js. On an unsupported one, it prints a
 * single line naming the required range and sets a non-zero exit code instead,
 * without loading modules that may fail to load there. When `start` rejects,
 * for example because a module fails to load, it prints the error, with its
 * cause and properties such as `code`, and sets a
 * non-zero exit code, as `runCli` does for errors the CLI throws.
 *
 * @param {string} command The bin name to report.
 * @param {() => Promise<void>} start Loads and runs the entry.
 * @returns {Promise<void>}
 */
export function startOnSupportedNode(command, start) {
  if (!nodeSatisfiesEngineRange(process.version)) {
    process.stderr.write(
      `${command} requires Node.js ${NODE_ENGINE_RANGE}. This is Node.js ${process.version}.\n`,
    );
    process.exitCode = 1;
    return Promise.resolve();
  }

  return start().catch((error) => {
    process.stderr.write(`${inspect(error)}\n`);
    process.exitCode = 1;
  });
}
