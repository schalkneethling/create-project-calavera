// @ts-check
import { dirname, isAbsolute, join, resolve } from "node:path";

import { TomlError, parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

import { readConfigText, unparseableWarning } from "./config-files.js";

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
 * sets neither, so loadNpmRegistryOptions first removes launcher variables that came from a .env
 * file Bun loaded.
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

/**
 * Every environment file that Yarn 4.18.1 may have loaded into the binaries it runs
 * (`Configuration.find` in @yarnpkg/core). Yarn picks the files before it loads them, from its
 * starting folder, the `.yarnrc.yml` files above it and in the home folder, and the
 * YARN_INJECT_ENVIRONMENT_FILES and YARN_RC_FILENAME variables. Calavera cannot see that choice:
 * the starting folder differs under `yarn dlx`, a script runs in its workspace, the CLI may move
 * into another project, and a loaded file can itself set those variables. So it judges every file
 * that any of these sources names, from every folder that may have been Yarn's starting folder.
 * Yarn expands `${...}` in a path and unescapes `\\`, `\$`, and `\}` (`$Q`); a path that still
 * holds a variable after unescaping is `unresolved`, because Calavera cannot tell which file it is.
 * @param {{ folders: string[], home: string, env: NodeJS.ProcessEnv }} context
 */
export async function yarnEnvironmentFiles({ folders, home, env }) {
  /** @type {Set<string>} */
  const paths = new Set();
  let unresolved = false;
  /** @param {string} base @param {string} entry */
  const add = (base, entry) => {
    const text = entry.replace(/\?$/, "");
    if (/(?<!\\)(?:\\\\)*\$\{/.test(text)) {
      unresolved = true;
      return;
    }
    paths.add(resolve(base, text.replace(/\\([\\$}])/g, "$1")));
  };
  const variable = Object.entries(env).find(
    ([name]) => name.toLowerCase() === "yarn_inject_environment_files",
  )?.[1];
  const rcNames = new Set([
    ".yarnrc.yml",
    ...Object.entries(env)
      .filter(([name, value]) => name.toLowerCase() === "yarn_rc_filename" && value)
      .map(([, value]) => /** @type {string} */ (value)),
  ]);
  /** @type {Set<string>} */
  const rcFiles = new Set([join(home, ".yarnrc.yml")]);
  for (const folder of folders) {
    add(folder, ".env.yarn");
    if (variable !== undefined)
      for (const entry of variable.split(",")) if (entry) add(folder, entry);
    for (let directory = resolve(folder); ; directory = dirname(directory)) {
      for (const name of rcNames) rcFiles.add(join(directory, name));
      if (dirname(directory) === directory) break;
    }
  }
  for (const rcFile of rcFiles) {
    // yarnLayers already warns about a file it cannot read or parse.
    const files = (await readYarnrc(rcFile, [])).injectEnvironmentFiles;
    if (!Array.isArray(files)) continue;
    for (const file of files) if (typeof file === "string") add(dirname(rcFile), file);
  }
  return { paths: [...paths], unresolved };
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
