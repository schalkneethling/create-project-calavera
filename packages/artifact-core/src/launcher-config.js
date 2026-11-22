// @ts-check
import { dirname, isAbsolute, join, resolve } from "node:path";

import { TomlError, parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

import { readConfigText, unparseableWarning } from "./config-files.js";

// Yarn 2 or later and Bun read registry settings of their own. Calavera reads the part of them
// that picks the registry (and, for Yarn, the proxy), so a lookup asks the registry that
// installed Calavera. Credentials stay with the .npmrc files: Calavera does not read
// `npmAuthToken` from .yarnrc.yml or `token`, `username`, and `password` from bunfig.toml.

/** The default of `npmRegistryServer` (plugin-npm, https://yarnpkg.com/configuration/yarnrc). */
export const YARN_DEFAULT_REGISTRY = "https://registry.yarnpkg.com";

const YARN_VARIABLES = new Map([
  ["yarn_npm_registry_server", "registry"],
  ["yarn_http_proxy", "yarn-http-proxy"],
  ["yarn_https_proxy", "yarn-https-proxy"],
]);

/**
 * @typedef {"npm" | "yarn" | "bun"} Launcher
 * @typedef {{ text: string, unset: string[], notes?: string[] }} Expansion
 * @typedef {{
 *   name: string,
 *   entries: Record<string, unknown>,
 *   trusted: boolean,
 *   tool?: "Yarn" | "Bun",
 *   settingNames?: Record<string, string>,
 *   expand?: (value: string, env: NodeJS.ProcessEnv, context: { setting: string, layer: string }) => Expansion,
 * }} LauncherLayer
 */

/**
 * The package manager that started Calavera, from the user agent it exports. Yarn sets
 * `npm_config_user_agent` to `yarn/<version> npm/? node/...` for scripts and binaries
 * (`makeScriptEnv` in @yarnpkg/core scriptUtils.ts), and Bun to `bun/<version> npm/? node/...`.
 * Yarn 1 reads .npmrc files, so it counts as npm here.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Launcher}
 */
export function detectLauncher(env) {
  const agent = env.npm_config_user_agent ?? "";
  const yarn = /^yarn\/(\d+)\./.exec(agent);
  if (yarn && Number(yarn[1]) >= 2) return "yarn";
  if (agent.startsWith("bun/")) return "bun";
  return "npm";
}

// Yarn's interpolation: ${NAME}, ${NAME:-fallback} (unset or empty), and ${NAME-fallback} (unset).
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
 * can be repository content, so it is not trusted.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, home: string, scope?: string, warnings: string[] }} context
 * @returns {Promise<LauncherLayer[]>}
 */
export async function yarnLayers({ cwd, env, home, scope, warnings }) {
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
    const { entries, settingNames } = yarnEntries(await readYarnrc(path, warnings), scope);
    layers.push({
      name: trusted ? "user .yarnrc.yml" : "project .yarnrc.yml",
      entries,
      settingNames,
      trusted,
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
    trusted: true,
    tool: "Yarn",
    expand: expandYarn,
  });
  return layers;
}

/**
 * Removes a username and password from a Bun registry URL. Bun accepts them there, but Calavera
 * reads credentials from .npmrc files only, and the URL must never carry them into a request
 * option or a message.
 * @param {string} url
 */
function withoutCredentials(url) {
  if (!URL.canParse(url)) return { url, removed: false };
  const parsed = new URL(url);
  if (!parsed.username && !parsed.password) return { url, removed: false };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.href, removed: true };
}

/** @param {string} setting @param {string} layer */
function credentialsNote(setting, layer) {
  return `Used ${setting} from the ${layer} without its credentials: Calavera does not read credentials from Bun's registry settings. Set them in an .npmrc file instead.`;
}

/**
 * The URL of a bunfig.toml registry value, which is a URL string or a table with `url`. Calavera
 * does not read the credentials a value can carry, so it removes them from the URL and notes it.
 * A value that starts with $ is expanded later, and its credentials are removed then.
 * @param {unknown} value
 * @param {string} setting
 * @param {string} layer
 * @param {string[]} notes
 */
function bunRegistryUrl(value, setting, layer, notes) {
  let url = value;
  let credentials = false;
  if (value && typeof value === "object") {
    const table = /** @type {Record<string, unknown>} */ (value);
    url = table.url;
    credentials = ["token", "username", "password"].some((key) => table[key] !== undefined);
  }
  if (typeof url !== "string") return undefined;
  const stripped = withoutCredentials(url);
  if (credentials || stripped.removed) notes.push(credentialsNote(setting, layer));
  return stripped.url;
}

/**
 * @param {string} path
 * @param {string} layer
 * @param {string | undefined} scope
 * @param {string[]} warnings
 * @param {string[]} notes
 */
async function readBunfig(path, layer, scope, warnings, notes) {
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
  entries.registry = bunRegistryUrl(install.registry, "install.registry", layer, notes);
  settingNames.registry = "install.registry";
  const scopes = /** @type {Record<string, unknown> | undefined} */ (install.scopes);
  if (scope && scopes) {
    // The Bun documentation writes scope keys both with the @ and without it.
    const name = Object.hasOwn(scopes, scope) ? scope : scope.slice(1);
    const setting = `install.scopes.${name}`;
    entries[`${scope}:registry`] = bunRegistryUrl(scopes[name], setting, layer, notes);
    settingNames[`${scope}:registry`] = setting;
  }
  return { entries, settingNames };
}

/**
 * Bun replaces a registry URL that starts with $ with the value of the variable it names
 * (`Scope.fromAPI` in Bun's src/install/npm.zig). The loader applies this to the user file only,
 * and removes credentials from the expanded value as it does from a literal one.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 * @param {{ setting: string, layer: string }} context
 * @returns {Expansion}
 */
function expandBun(text, env, { setting, layer }) {
  if (!text.startsWith("$")) return { text, unset: [] };
  const name = text.slice(1);
  const value = env[name];
  if (value === undefined) return { text, unset: [name] };
  return withoutCredentialsExpansion(value, setting, layer);
}

/**
 * @param {string} value
 * @param {string} setting
 * @param {string} layer
 * @returns {Expansion}
 */
function withoutCredentialsExpansion(value, setting, layer) {
  const { url, removed } = withoutCredentials(value);
  return { text: url, unset: [], notes: removed ? [credentialsNote(setting, layer)] : [] };
}

/**
 * The bunfig.toml layers, lowest precedence first: the global file, then the project file in `cwd`
 * ("keys set in the local file override the same keys in the global file",
 * https://bun.com/docs/runtime/bunfig). The global file is `$XDG_CONFIG_HOME/.bunfig.toml` when
 * that variable is an absolute path, and `$HOME/.bunfig.toml` otherwise. Bun loads them after the
 * .npmrc files and before `BUN_CONFIG_REGISTRY` and `NPM_CONFIG_REGISTRY`
 * (https://bun.com/docs/install/npmrc). A registry URL that starts with $ is read from the
 * variable it names, in the user file only.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, home: string, scope?: string, warnings: string[], notes: string[] }} context
 * @returns {Promise<LauncherLayer[]>}
 */
export async function bunfigLayers({ cwd, env, home, scope, warnings, notes }) {
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
      ...(await readBunfig(path, name, scope, warnings, notes)),
      expand: expandBun,
    })),
  );
}

/**
 * The registry variables Bun reads after bunfig.toml, in its order: the first that starts with
 * https:// or http:// wins, and any other value is skipped (`load` in Bun 1.3.9's
 * src/install/PackageManager/PackageManagerOptions.zig). Bun accepts credentials in the URL, so
 * Calavera removes them, as it does for bunfig.toml.
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
    trusted: true,
    tool: "Bun",
    expand: (text, _env, { setting, layer }) => withoutCredentialsExpansion(text, setting, layer),
  };
}
