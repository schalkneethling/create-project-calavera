// @ts-check
import { readdir, readFile as readFileText, readlink as readLink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { TomlError, parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

import { printable, readConfigText, unparseableWarning } from "./config-files.js";
import { parseEnvironmentFile } from "./environment-files.js";

// Yarn 2 or later and Bun read registry settings of their own. Calavera reads the part of them
// that picks the registry (and, for Yarn, the proxy), so a lookup asks the registry that
// installed Calavera. Calavera reads no credential from them (ADR-0021): only the keys below are
// ever taken from a parsed file.

/** The default of `npmRegistryServer` (plugin-npm, https://yarnpkg.com/configuration/yarnrc). */
export const YARN_DEFAULT_REGISTRY = "https://registry.yarnpkg.com";

const YARN_VARIABLES = new Map([
  ["yarn_npm_registry_server", "registry"],
  ["yarn_http_proxy", "yarn-http-proxy"],
  ["yarn_https_proxy", "yarn-https-proxy"],
]);

/**
 * @typedef {"npm" | "yarn" | "bun"} Launcher
 * @typedef {{ text: string, unset: string[] }} Expansion
 * @typedef {{
 *   name: string,
 *   entries: Record<string, unknown>,
 *   trusted: boolean,
 *   expandsVariables?: boolean,
 *   variables?: Record<string, string>,
 *   tool?: "Yarn" | "Bun",
 *   settingNames?: Record<string, string>,
 *   expand?: (value: string, env: NodeJS.ProcessEnv) => Expansion,
 * }} LauncherLayer
 */

// The file names npm and pnpm give npm_execpath: npm's bin/npm-cli.js (also under npx), and pnpm's
// executable or bin/pnpm.cjs.
const NPM_OR_PNPM_EXECPATH = /^(npm-cli\.js|pnpm(\.exe|\.cjs|\.mjs|\.js)?)$/i;

/**
 * The package manager that started Calavera, from the user agent it exports. Yarn sets
 * `npm_config_user_agent` to `yarn/<version> npm/? node/...` for scripts and binaries
 * (`makeScriptEnv` in @yarnpkg/core scriptUtils.ts), and Bun to `bun/<version> npm/? node/...`.
 * Yarn 1 reads .npmrc files, so it counts as npm here.
 *
 * npm exports a project .npmrc `user-agent`, and pnpm its `userAgent` setting, as the user agent,
 * so repository content can make it name Yarn or Bun (#1186). Both also set npm_execpath to their
 * own binary, which no project setting changes, so a npm_execpath that names npm or pnpm wins over
 * the user agent. Yarn 4 and `bun run` set both variables themselves, after a Yarn `.env.yarn` or
 * a Bun `.env` is applied, so their user agent can be trusted. A direct Bun run (`bun file.js`)
 * sets neither; when Bun runs Calavera and the variables are absent, or a .env file Bun loaded
 * defines them, loadNpmRegistryOptions reads the Bun settings instead of this result.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Launcher}
 */
export function detectLauncher(env) {
  const execFile = env.npm_execpath?.split(/[\\/]/).pop() ?? "";
  if (NPM_OR_PNPM_EXECPATH.test(execFile)) return "npm";
  const agent = env.npm_config_user_agent ?? "";
  const yarn = /^yarn\/(\d+)\./.exec(agent);
  if (yarn && Number(yarn[1]) >= 2) return "yarn";
  if (agent.startsWith("bun/")) return "bun";
  return "npm";
}

// Yarn's interpolation, which Calavera applies to proxy values only; a registry value with a
// variable stops the command (ADR-0021 Decision 2): ${NAME}, ${NAME:-fallback} (unset or empty),
// and ${NAME-fallback} (unset).
// Only a literal fallback is supported. Anything else that starts with ${ is left unexpanded and
// reported, so the setting is ignored instead of being sent with a placeholder.
// Names start with a letter, as in Yarn's `replaceEnvVariables`. An escaped \${ is not expanded,
// so the check below reports it and the setting is ignored.
const YARN_VARIABLE = /(?<!\\)\$\{([A-Za-z]\w*)(?:(:?-)([^${}]*))?\}/g;

/**
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 * @returns {Expansion}
 */
function expandYarn(value, env) {
  /** @type {string[]} */
  const unset = [];
  const text = value.replace(YARN_VARIABLE, (original, name, operator, fallback) => {
    const current = env[name];
    if (operator === ":-") return current ? current : fallback;
    if (operator === "-") return current ?? fallback;
    if (current === undefined) unset.push(name);
    return current ?? original;
  });
  // A ${ that the expression did not match, such as a nested fallback, is not understood.
  if (text.includes("${") && unset.length === 0) unset.push("an unsupported ${...} expression");
  return { text, unset };
}

/**
 * The Yarn settings Calavera reads, under the keys the loader works with. The proxy keys are
 * internal: the loader picks one of them by the registry protocol, as Yarn does.
 * @param {Record<string, unknown>} settings
 * @param {string | undefined} scope
 */
function yarnEntries(settings, scope) {
  /** @type {Record<string, unknown>} */
  const entries = {};
  /** @type {Record<string, string>} */
  const settingNames = {};
  /** @param {string} key @param {string} name @param {unknown} value */
  const add = (key, name, value) => {
    entries[key] = value;
    settingNames[key] = name;
  };
  add("registry", "npmRegistryServer", settings.npmRegistryServer);
  add("yarn-http-proxy", "httpProxy", settings.httpProxy);
  add("yarn-https-proxy", "httpsProxy", settings.httpsProxy);
  // npmScopes keys name the scope without its @ (npmConfigUtils.getScopeConfiguration).
  const scopes = /** @type {Record<string, { npmRegistryServer?: unknown } | null> | undefined} */ (
    settings.npmScopes
  );
  if (scope && scopes) {
    const name = scope.slice(1);
    add(
      `${scope}:registry`,
      `npmScopes.${name}.npmRegistryServer`,
      scopes[name]?.npmRegistryServer,
    );
  }
  return { entries, settingNames };
}

/**
 * Whether `path` is the file `name` in the operating system account's home folder: the user's own
 * file, not one that HOME, npm_config_userconfig, or a project file chose (#1186).
 * @param {string} path
 * @param {string | undefined} accountHome
 * @param {string} name
 */
export function isAccountFile(path, accountHome, name) {
  return accountHome !== undefined && resolve(path) === resolve(accountHome, name);
}

/**
 * @param {string} path
 * @param {string[]} warnings
 * @returns {Promise<Record<string, unknown>>}
 */
async function readYarnrc(path, warnings) {
  const text = await readConfigText(path, "Yarn configuration file", warnings);
  if (text === undefined) return {};
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    const position = document.errors[0]?.linePos?.[0];
    warnings.push(
      unparseableWarning(path, "Yarn configuration file", position?.line, position?.col),
    );
    return {};
  }
  try {
    // A file that is empty or holds a single value has no settings.
    return document.toJS() ?? {};
  } catch {
    // toJS throws on a file with excessive aliases. Its message is not passed on.
    warnings.push(unparseableWarning(path, "Yarn configuration file", undefined, undefined));
    return {};
  }
}

/**
 * The Yarn layers, lowest precedence first: the home .yarnrc.yml, then each .yarnrc.yml from the
 * file system root down to `cwd`, so the nearest file wins, then `YARN_*` variables, which
 * override every file (`Configuration.find` in @yarnpkg/core). `YARN_RC_FILENAME` renames the
 * files Yarn searches, but not the home file. The home file is the user's own; every other file
 * can be repository content, so it is not trusted. A Yarn 4 `.env.yarn` can set HOME, so the home
 * file expands variables only when it is in `accountHome`, the operating system account's home.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, home: string, accountHome: string | undefined, scope?: string, warnings: string[] }} context
 * @returns {Promise<LauncherLayer[]>}
 */
export async function yarnLayers({ cwd, env, home, accountHome, scope, warnings }) {
  const rcFilename =
    Object.entries(env).find(([name]) => name.toLowerCase() === "yarn_rc_filename")?.[1] ||
    ".yarnrc.yml";
  const homePath = join(home, ".yarnrc.yml");
  /** @type {string[]} */
  const paths = [];
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    paths.unshift(join(directory, rcFilename));
    if (dirname(directory) === directory) break;
  }
  if (!paths.includes(homePath)) paths.unshift(homePath);

  /** @type {LauncherLayer[]} */
  const layers = [];
  for (const path of paths) {
    const trusted = path === homePath;
    const settings = await readYarnrc(path, warnings);
    const { entries, settingNames } = yarnEntries(settings, scope);

    layers.push({
      name: trusted ? "user .yarnrc.yml" : "project .yarnrc.yml",
      entries,
      settingNames,
      trusted,
      expandsVariables: trusted && isAccountFile(path, accountHome, ".yarnrc.yml"),

      tool: "Yarn",
      expand: expandYarn,
    });
  }

  // Yarn lowercases the name, removes the yarn_ prefix, and camel-cases the rest, so
  // YARN_NPM_REGISTRY_SERVER sets npmRegistryServer (`getEnvironmentSettings` in @yarnpkg/core).
  /** @type {Record<string, unknown>} */
  const entries = {};
  /** @type {Record<string, string>} */
  const settingNames = {};
  for (const [name, value] of Object.entries(env)) {
    const key = YARN_VARIABLES.get(name.toLowerCase());
    if (key && value) {
      entries[key] = value;
      settingNames[key] = name;
    }
  }
  layers.push({
    name: "environment",
    entries,
    settingNames,
    variables: settingNames,
    trusted: true,
    tool: "Yarn",
    expand: expandYarn,
  });
  return layers;
}

// The variables, beside YARN_INJECT_ENVIRONMENT_FILES, that decide which environment files Yarn
// loads. Yarn reads them from its own environment before it loads the files, but a loaded file can
// change them for the child. On Windows, os.homedir() reads USERPROFILE rather than HOME.
// How many project folders Calavera searches for a .env.yarn when it cannot see Yarn's folder.
const YARN_PROJECT_FOLDER_LIMIT = 10_000;
const YARN_FILE_INPUTS = [
  "yarn_rc_filename",
  "yarn_inject_environment_files",
  "home",
  "userprofile",
];

/**
 * Whether a parent process's arguments run Yarn: the program or the script it runs is `yarn`,
 * Yarn's bundle `yarn.js` or `yarn.cjs`, or a Yarn release such as `yarn-4.18.1.cjs`.
 * @param {string[]} args
 */
function runsYarn(args) {
  return args
    .slice(0, 2)
    .some((arg) => /^yarn(?:-\d[\w.-]*\.c?js|\.c?js)?$/.test(arg.split(/[\\/]/).pop() ?? ""));
}

/**
 * The working folder of the Yarn process that started Calavera, or null when it cannot be read.
 * Yarn reads its default `.env.yarn` from this folder, which it does not pass to the child: under
 * `--cwd`, `yarn workspace`, and `yarn workspaces foreach`, INIT_CWD names another folder, and
 * Yarn overwrites PWD. It comes from /proc, so only on Linux, and only when the parent runs Yarn,
 * so a shell script between Yarn and Calavera gives null. Elsewhere, such as on macOS and Windows,
 * yarnEnvironmentFiles judges the candidate `.env.yarn` files instead (owner decision on #1186).
 * @param {{ platform?: string, ppid?: number, readFile?: (path: string) => Promise<string>, readlink?: (path: string) => Promise<string> }} [system]
 */
export async function yarnParentCwd({
  platform = process.platform,
  ppid = process.ppid,
  readFile = (path) => readFileText(path, "utf8"),
  readlink = (path) => readLink(path),
} = {}) {
  try {
    if (platform === "linux") {
      const args = (await readFile(`/proc/${ppid}/cmdline`)).split("\0");
      return runsYarn(args) ? await readlink(`/proc/${ppid}/cwd`) : null;
    }
  } catch {
    // An unreadable or missing source leaves the folder unknown.
  }
  return null;
}

/**
 * Whether an environment variable name is the Yarn setting `setting`, as Yarn reads its variables:
 * lowercased, the `yarn_` prefix removed, and the rest camel-cased (`getEnvironmentSettings` in
 * @yarnpkg/core), so YARN_INJECT_ENVIRONMENT__FILES is injectEnvironmentFiles too.
 * @param {string} name @param {string} setting
 */
function isYarnSetting(name, setting) {
  const lower = name.toLowerCase();
  if (!lower.startsWith("yarn_")) return false;
  const words = lower
    .slice("yarn_".length)
    .split(/[_\-\s.]+/)
    .filter(Boolean);
  const camel = words
    .map((word, index) => (index ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join("");
  return camel === setting;
}

/**
 * The environment files Yarn 4.18.1 loaded into the environment of the binary or script that runs
 * Calavera, lowest precedence first (`Configuration.find` and `makeScriptEnv` in @yarnpkg/core):
 *
 * - Yarn passes the folder it works in, which --cwd and `yarn workspace` set, as INIT_CWD; without
 *   it, Yarn's script environment did not start Calavera, and no file was loaded.
 * - The `injectEnvironmentFiles` lists of `~/.yarnrc.yml` (from `os.homedir()`) and of each
 *   `.yarnrc.yml`, or the file YARN_RC_FILENAME names, from the root down to INIT_CWD are joined,
 *   home first, each entry resolved from its file's folder.
 * - Without a list, the default `.env.yarn` is read from Yarn's own process folder
 *   (`yarnProcessCwd`). When that folder is unknown, every `.env.yarn` Yarn could have read is a
 *   candidate (`candidates`), and each counts on its own.
 * - A trailing `?` makes a file optional. Yarn unescapes `\\`, `\$`, and `\}` in a path and
 *   expands `${...}` in it with an empty environment, as no environment is loaded yet.
 *
 * `undetermined` gives a reason and a remedy when Calavera cannot tell which files Yarn loaded:
 * YARN_INJECT_ENVIRONMENT_FILES is set, which a loaded file could have changed; a settings file
 * uses a form of the setting that Calavera does not model; a path has a variable without a value;
 * HOME names another folder than the account's home while a home settings file lists files; a
 * file Yarn may have loaded sets one of Yarn's inputs; or the default applies, Yarn's process
 * folder is unknown, and the candidate folders cannot be bounded (no PROJECT_CWD, or more project
 * folders than `folderLimit`).
 * @param {{ env: NodeJS.ProcessEnv, startingCwd: string, accountHome: string | undefined, cwd: string, yarnProcessCwd: string | null, folderLimit?: number }} context
 * @returns {Promise<{ paths: string[], candidates?: boolean, undetermined?: { reason: string, remedy: string } }>}
 */
export async function yarnEnvironmentFiles({
  env,
  startingCwd,
  accountHome,
  cwd,
  yarnProcessCwd,
  folderLimit = YARN_PROJECT_FOLDER_LIMIT,
}) {
  if (!env.INIT_CWD) return { paths: [] };
  const yarnStart = resolve(env.INIT_CWD);
  /** @param {string} path */
  const label = (path) => printable(relative(cwd, path) || path);
  /** @param {string} reason @param {string} remedy */
  const undetermined = (reason, remedy) => ({ paths: [], undetermined: { reason, remedy } });

  if (Object.keys(env).some((name) => isYarnSetting(name, "injectEnvironmentFiles"))) {
    return undetermined(
      "YARN_INJECT_ENVIRONMENT_FILES is set, and a file that Yarn loaded can change it, so Calavera cannot tell the value Yarn used",
      "List the files in injectEnvironmentFiles in the project's .yarnrc.yml instead.",
    );
  }
  const rcName =
    Object.entries(env).find(([name]) => name.toLowerCase() === "yarn_rc_filename")?.[1] ||
    ".yarnrc.yml";
  const seenHome =
    (process.platform === "win32" ? env.USERPROFILE : env.HOME) || accountHome || homedir();

  /**
   * The joined lists of the settings files for one home folder, or the reason Calavera cannot
   * model them. Yarn takes the nearest file's value and, while the values are lists, prepends the
   * lists of farther files; another form stops the join (`W9` in @yarnpkg/core).
   * @param {string} home
   */
  const listsFor = async (home) => {
    /** @type {string[]} */
    const rcFiles = [];
    for (let directory = yarnStart; ; directory = dirname(directory)) {
      rcFiles.unshift(join(directory, rcName));
      if (dirname(directory) === directory) break;
    }
    const homeRc = join(home, ".yarnrc.yml");
    if (!rcFiles.includes(homeRc)) rcFiles.unshift(homeRc);
    /** @type {{ rcFile: string, entries: string[] }[]} */
    const lists = [];
    for (const rcFile of [...rcFiles].reverse()) {
      // yarnLayers already warns about a file it cannot read or parse.
      const value = (await readYarnrc(rcFile, [])).injectEnvironmentFiles;
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        return { rcFile, unmodelled: true, lists };
      }
      lists.unshift({ rcFile, entries: value });
    }
    return { rcFile: undefined, unmodelled: false, lists };
  };

  const seen = await listsFor(seenHome);
  if (seen.unmodelled && seen.rcFile) {
    return undetermined(
      `${label(seen.rcFile)} sets injectEnvironmentFiles in a form Calavera does not read`,
      "Write injectEnvironmentFiles as a list of paths.",
    );
  }
  if (accountHome !== undefined && resolve(seenHome) !== resolve(accountHome)) {
    const own = await listsFor(accountHome);
    const homeLists = [...seen.lists, ...own.lists].some(
      ({ rcFile }) =>
        rcFile === join(seenHome, ".yarnrc.yml") || rcFile === join(accountHome, ".yarnrc.yml"),
    );
    if (homeLists || own.unmodelled) {
      return undetermined(
        "HOME names another folder than your account's home, a home .yarnrc.yml lists environment files, and a file that Yarn loaded can change HOME",
        "List the files in the project's .yarnrc.yml instead of the home one.",
      );
    }
  }

  /** @type {string[]} */
  const paths = [];
  // True when `paths` are the files Yarn could have read, any of which it may have loaded.
  let candidates = false;
  for (const { rcFile, entries } of seen.lists) {
    for (const entry of entries) {
      const expanded = expandYarn(entry.replace(/\?$/, ""), {});
      if (expanded.unset.length > 0) {
        return undetermined(
          "a .yarnrc.yml setting names an environment file with a variable in its path that Yarn cannot expand",
          "Write the path without a variable.",
        );
      }
      paths.push(resolve(dirname(rcFile), expanded.text.replace(/\\([\\$}])/g, "$1")));
    }
  }
  if (seen.lists.length === 0) {
    if (yarnProcessCwd !== null) {
      paths.push(join(resolve(yarnProcessCwd), ".env.yarn"));
    } else {
      // Yarn's folder is unknown (no /proc), so every .env.yarn it could have read counts, each on
      // its own. From the source: `yarn workspace` and `yarn workspaces foreach` run anywhere in
      // the project, which Yarn passes as PROJECT_CWD; `yarn --cwd` runs in a folder above the
      // folder it names, when that is relative; and `yarn dlx`, whose PROJECT_CWD and INIT_CWD
      // name a temporary project, runs the binary where Calavera starts. A run started outside
      // these folders, such as `yarn --cwd /elsewhere` from an unrelated folder, is not covered.
      if (!env.PROJECT_CWD) {
        return undetermined(
          "it cannot see the folder Yarn ran in, and Yarn passed no PROJECT_CWD, so the folders Yarn could have run in are unknown",
          "List the file Yarn loads in injectEnvironmentFiles in the project's .yarnrc.yml, or an empty list if it loads none, so Calavera can tell.",
        );
      }
      const projectCwd = resolve(env.PROJECT_CWD);
      /** @type {Set<string>} */
      const folders = new Set();
      for (const start of [yarnStart, projectCwd, resolve(startingCwd)]) {
        for (let directory = start; ; directory = dirname(directory)) {
          folders.add(directory);
          if (dirname(directory) === directory) break;
        }
      }
      const inProject = await projectFolders(projectCwd, folderLimit);
      if (inProject === undefined) {
        return undetermined(
          "it cannot see the folder Yarn ran in, and the project has more folders than Calavera searches for a .env.yarn",
          "List the file Yarn loads in injectEnvironmentFiles in the project's .yarnrc.yml, or an empty list if it loads none, so Calavera can tell.",
        );
      }
      for (const folder of inProject) folders.add(folder);
      for (const folder of folders) {
        const path = join(folder, ".env.yarn");
        if ((await readConfigText(path, "environment file", [])) !== undefined) paths.push(path);
      }
      candidates = true;
    }
  }
  // A loaded file that sets one of Yarn's inputs means the values Calavera sees may not be the
  // ones Yarn used.
  for (const path of paths) {
    const text = await readConfigText(path, "environment file", []);
    if (text === undefined) continue;
    const key = [...parseEnvironmentFile(text).keys()].find(
      (each) =>
        YARN_FILE_INPUTS.includes(each.toLowerCase()) ||
        isYarnSetting(each, "injectEnvironmentFiles"),
    );
    if (key !== undefined) {
      const name = printable(key);
      return undetermined(
        `${label(path)} sets ${name}, which changes the files Yarn loads`,
        `Remove ${name} from ${label(path)}.`,
      );
    }
  }
  return { paths, candidates };
}

/**
 * Every folder in `root`, `root` included, except node_modules and dot-folders, or undefined
 * when there are more than `limit`.
 * @param {string} root @param {number} limit
 */
async function projectFolders(root, limit) {
  /** @type {string[]} */
  const folders = [];
  const pending = [root];
  while (pending.length > 0) {
    const folder = /** @type {string} */ (pending.pop());
    folders.push(folder);
    if (folders.length > limit) return undefined;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // node_modules and dot-folders, such as .git, .yarn, and .next, are not where Yarn runs.
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        pending.push(join(folder, entry.name));
      }
    }
  }
  return folders;
}

/**
 * The URL of a bunfig.toml registry value, which is a URL string or a table with `url`. No other
 * key of the table is read. The loader removes any username and password from the URL, with a
 * warning, as it does for every registry setting.
 * @param {unknown} value
 */
function bunRegistryUrl(value) {
  const url =
    value && typeof value === "object" ? /** @type {{ url?: unknown }} */ (value).url : value;
  return typeof url === "string" ? url : undefined;
}

/**
 * @param {string} path
 * @param {string | undefined} scope
 * @param {string[]} warnings
 */
async function readBunfig(path, scope, warnings) {
  /** @type {Record<string, unknown>} */
  const entries = {};
  /** @type {Record<string, string>} */
  const settingNames = {};
  const text = await readConfigText(path, "Bun configuration file", warnings);
  if (text === undefined) return { entries, settingNames };
  /** @type {Record<string, unknown>} */
  let settings;
  try {
    settings = parseToml(text);
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    warnings.push(unparseableWarning(path, "Bun configuration file", error.line, error.column));
    return { entries, settingNames };
  }
  const install = /** @type {Record<string, unknown>} */ (settings.install ?? {});
  entries.registry = bunRegistryUrl(install.registry);
  settingNames.registry = "install.registry";
  const scopes = /** @type {Record<string, unknown> | undefined} */ (install.scopes);
  if (scope && scopes) {
    // The Bun documentation writes scope keys both with the @ and without it.
    const name = Object.hasOwn(scopes, scope) ? scope : scope.slice(1);
    const setting = `install.scopes.${name}`;
    entries[`${scope}:registry`] = bunRegistryUrl(scopes[name]);
    settingNames[`${scope}:registry`] = setting;
  }
  return { entries, settingNames };
}

/**
 * The bunfig.toml layers, lowest precedence first: the global file, then the project file in `cwd`
 * ("keys set in the local file override the same keys in the global file",
 * https://bun.com/docs/runtime/bunfig). The global file is `$XDG_CONFIG_HOME/.bunfig.toml` when
 * that variable is an absolute path, and `$HOME/.bunfig.toml` otherwise. Bun loads them after the
 * .npmrc files and before the registry variables (see bunEnvironmentLayer)
 * (https://bun.com/docs/install/npmrc). Bun reads a registry URL that starts with $ from the
 * variable it names; the loader stops on such a value instead (ADR-0021 Decision 2).
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, home: string, scope?: string, warnings: string[] }} context
 * @returns {Promise<LauncherLayer[]>}
 */
export async function bunfigLayers({ cwd, env, home, scope, warnings }) {
  const xdg = env.XDG_CONFIG_HOME;
  const globalPath = join(xdg && isAbsolute(xdg) ? xdg : home, ".bunfig.toml");
  const projectPath = resolve(cwd, "bunfig.toml");
  const layers = [
    { name: "user bunfig.toml", path: globalPath, trusted: true },
    { name: "project bunfig.toml", path: projectPath, trusted: false },
  ];
  return Promise.all(
    layers.map(async ({ name, path, trusted }) => ({
      name,
      trusted,
      tool: /** @type {const} */ ("Bun"),
      ...(await readBunfig(path, scope, warnings)),
    })),
  );
}

/**
 * The registry variables Bun reads after bunfig.toml, in its order: the first that starts with
 * https:// or http:// wins, and any other value is skipped (`load` in Bun 1.3.9's
 * src/install/PackageManager/PackageManagerOptions.zig). The loader removes any username and
 * password from the URL, as it does for bunfig.toml.
 * @param {NodeJS.ProcessEnv} env
 * @returns {LauncherLayer}
 */
export function bunEnvironmentLayer(env) {
  const name = ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"].find(
    (variable) => /^https?:\/\//.test(env[variable] ?? ""),
  );
  return {
    name: "environment",
    entries: name ? { registry: env[name] } : {},
    settingNames: name ? { registry: name } : {},
    variables: name ? { registry: name } : {},
    trusted: true,
    tool: "Bun",
  };
}
