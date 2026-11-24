// @ts-check
// The core of the CLI version notice (#675, ADR-0019). It decides whether a run checks, asks a
// resolver for the `latest` version, and returns the notice's facts. It holds no registry code,
// no deadline, and no printing: the CLI adapter in index.js passes the resolver, holds the request
// to its deadline, and prints the result, so the tests here need no network (Decision 7).
import { readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

import semver from "semver";

import { formatErrorChain, isDebugEnabled } from "./utils/error-chain.js";
import { isPathInside } from "./utils/fs.js";

/** How long the request may take from its start, in milliseconds (Decision 2). */
export const VERSION_CHECK_DEADLINE_MS = 1_500;

/**
 * Whether `CALAVERA_NO_VERSION_CHECK` turns the check off. It parses like `CALAVERA_DEBUG`: `1` or
 * `true`, in any letter case (Decision 5).
 *
 * @param {Record<string, string | undefined>} env
 */
export function isVersionCheckDisabled(env) {
  return /^(?:1|true)$/i.test(env.CALAVERA_NO_VERSION_CHECK ?? "");
}

/**
 * Whether a run checks for a newer version (Decision 1). `--json` and `--help` skip it, and so do
 * `artifacts status` and `artifacts doctor` without `--check-updates`, which promise to contact no
 * registry. The MCP server never calls this.
 *
 * @param {{ command: string, json?: boolean, artifactAction?: string, checkUpdates?: boolean }} options
 * @param {Record<string, string | undefined>} env
 */
export function versionCheckApplies(options, env) {
  if (isVersionCheckDisabled(env) || options.json || options.command === "help") {
    return false;
  }

  const offlineArtifactCommand =
    options.command === "artifacts" &&
    (options.artifactAction === "status" || options.artifactAction === "doctor");

  return !offlineArtifactCommand || options.checkUpdates === true;
}

/**
 * Whether the running copy is the project's own dependency: its package folder is inside the
 * project's `node_modules`, and the project's `package.json` lists the package (Decision 4).
 *
 * @param {string} packageRoot
 * @param {string} cwd
 * @param {string} packageName
 */
async function isProjectDependency(packageRoot, cwd, packageName) {
  try {
    const [realRoot, realProject] = await Promise.all([realpath(packageRoot), realpath(cwd)]);
    const nodeModules = join(realProject, "node_modules");
    if (relative(nodeModules, realRoot) === "" || !isPathInside(nodeModules, realRoot)) {
      return false;
    }

    /** @type {Record<string, unknown>} */
    const manifest = JSON.parse(await readFile(join(realProject, "package.json"), "utf8"));
    return ["dependencies", "devDependencies", "optionalDependencies"].some((field) => {
      const dependencies = manifest[field];
      return (
        typeof dependencies === "object" && dependencies !== null && packageName in dependencies
      );
    });
  } catch {
    // A missing folder, or a package.json that is missing or not JSON, is no project dependency.
    return false;
  }
}

/**
 * @typedef {{ status: "skipped" }
 *   | { status: "current", latest: string }
 *   | { status: "newer", running: string, latest: string, command: string, update: string | undefined }
 *   | { status: "failed", error: unknown }} VersionCheckResult
 */

/**
 * Checks whether a newer version than the running one is `latest`. It never throws: a failure of
 * the resolver, or a `latest` that is not a valid version, is a `failed` result. `cwd` and `env`
 * are captured by the caller when the run starts, because `--new` changes the working directory
 * while the request may still be open.
 *
 * @param {{
 *   version: string,
 *   options: { command: string, json?: boolean, artifactAction?: string, checkUpdates?: boolean },
 *   cwd: string,
 *   env: Record<string, string | undefined>,
 *   packageRoot: string,
 *   packageName: string,
 *   resolveLatest: (context: { cwd: string, env: Record<string, string | undefined> }) => Promise<string>,
 *   runCommand: (latest: string) => string,
 *   updateCommand: (latest: string) => Promise<string>,
 * }} input `runCommand` gives this run's command pinned to a version; `updateCommand` gives the
 *   command that updates the project's dependency to a version.
 * @returns {Promise<VersionCheckResult>}
 */
export async function checkForNewerVersion({
  version,
  options,
  cwd,
  env,
  packageRoot,
  packageName,
  resolveLatest,
  runCommand,
  updateCommand,
}) {
  if (!versionCheckApplies(options, env)) {
    return { status: "skipped" };
  }

  try {
    const latest = await resolveLatest({ cwd, env });
    if (!semver.valid(latest)) {
      throw new Error(`The registry named no valid version as the latest ${packageName}.`);
    }

    if (!semver.lt(version, latest)) {
      return { status: "current", latest };
    }

    const update = (await isProjectDependency(packageRoot, cwd, packageName))
      ? await updateCommand(latest).catch(() => undefined)
      : undefined;
    return { status: "newer", running: version, latest, command: runCommand(latest), update };
  } catch (error) {
    return { status: "failed", error };
  }
}

/**
 * The text the CLI prints on standard error for a check's result, or `undefined` for none. A
 * failure prints nothing unless `CALAVERA_DEBUG` is on, and then its redacted cause chain, so a
 * person behind a proxy can see why no notice appears (Decision 6).
 *
 * @param {VersionCheckResult} result
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function versionNoticeText(result, env) {
  if (result.status === "failed") {
    return isDebugEnabled(env)
      ? `The check for a newer create-project-calavera failed, so no version notice is shown.\n${formatErrorChain(result.error, env)}`
      : undefined;
  }

  if (result.status !== "newer") {
    return undefined;
  }

  const notice = `create-project-calavera ${result.running} is running, but ${result.latest} is the latest release. To run ${result.latest}: ${result.command}`;
  return result.update === undefined
    ? notice
    : `${notice}\nThis project's create-project-calavera dependency is unchanged; to update it, run: ${result.update}`;
}
