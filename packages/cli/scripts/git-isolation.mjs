// Tests that read a repository's default branch must not depend on the machine that runs them:
// `git var GIT_DEFAULT_BRANCH` reads init.defaultBranch from the global and system configuration.
import { devNull } from "node:os";

/**
 * The environment with every GIT_ variable removed, because one that a parent process sets, such
 * as GIT_DIR in a hook, would point Git at another repository. Git then reads `globalConfig` as its
 * global configuration and no system configuration.
 *
 * `settings`, such as { "init.defaultBranch": "main" }, become Git's runtime configuration through
 * GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n>, and GIT_CONFIG_VALUE_<n> (see git help config).
 * maintenance.auto is always false: otherwise a commit can start `git maintenance run --auto` in
 * the background, whose .git/objects/maintenance.lock appears and disappears while a test compares
 * snapshots of the project.
 *
 * @param {string} [globalConfig]
 * @param {Record<string, string>} [settings]
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedGitEnv(globalConfig = devNull, settings = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const pairs = Object.entries({ "maintenance.auto": "false", ...settings });
  return {
    ...env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(pairs.length),
    ...Object.fromEntries(
      pairs.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
}

/**
 * Applies isolatedGitEnv to this test process, so the code under test and every child process it
 * starts read no Git configuration from the machine. Each test file runs in its own process.
 *
 * @param {Record<string, string>} [settings]
 */
export function isolateGitConfiguration(settings = {}) {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) delete process.env[name];
  }
  Object.assign(process.env, isolatedGitEnv(devNull, settings));
}
