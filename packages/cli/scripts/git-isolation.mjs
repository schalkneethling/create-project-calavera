// Tests that read a repository's default branch must not depend on the machine that runs them:
// `git var GIT_DEFAULT_BRANCH` reads init.defaultBranch from the global and system configuration.
import { devNull } from "node:os";

/**
 * The environment with every GIT_ variable removed, because one that a parent process sets, such
 * as GIT_DIR in a hook, would point Git at another repository. Git then reads `globalConfig` as its
 * global configuration and no system configuration.
 *
 * @param {string} [globalConfig]
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedGitEnv(globalConfig = devNull) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return { ...env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
}

/**
 * Applies isolatedGitEnv to this test process, so the code under test and every child process it
 * starts read no Git configuration from the machine. Each test file runs in its own process.
 * `settings`, such as { "init.defaultBranch": "main" }, become Git's runtime configuration through
 * GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n>, and GIT_CONFIG_VALUE_<n> (see git help config).
 *
 * @param {Record<string, string>} [settings]
 */
export function isolateGitConfiguration(settings = {}) {
  const env = isolatedGitEnv();
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) delete process.env[name];
  }
  Object.assign(process.env, env);
  const pairs = Object.entries(settings);
  if (pairs.length === 0) return;
  process.env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
}
