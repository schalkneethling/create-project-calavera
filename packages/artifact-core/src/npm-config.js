// @ts-check
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { decode } from "ini";

// pacote and npm-registry-fetch do not read .npmrc files. The npm CLI loads them with
// @npmcli/config and passes the result as options. This loader reproduces only the part that
// decides where a request goes and how it authenticates, with npm's precedence for those keys:
// user .npmrc, then project .npmrc, then npm_config_* environment variables.
// Global and built-in npmrc files, command-line flags, and other settings (proxy, CA) are not read.
// The project .npmrc is the one in `cwd`; parent directories are not searched.
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
// Nerf-darted keys such as //registry.example.com/:_authToken, as read by npm-registry-fetch.
const AUTH_KEY = /^\/\/.+:(?:_authToken|_auth|username|_password|certfile|keyfile)$/;
// Same expression as @npmcli/config: ${VAR}, ${VAR?} for an empty fallback, and backslash escapes.
const ENV_EXPRESSION = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;

/**
 * @typedef {"user .npmrc" | "project .npmrc" | "environment"} Layer
 * @typedef {{ host: string, source: Layer | "default" }} EffectiveRegistry
 */

/**
 * Expands variables like @npmcli/config. A variable that is not set is left in place and listed.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 */
function expandEnvironment(value, env) {
  /** @type {string[]} */
  const unset = [];
  const text = value.replace(ENV_EXPRESSION, (original, escapes, name, modifier) => {
    if (env[name] === undefined && modifier !== "?" && escapes.length % 2 === 0) unset.push(name);
    const replacement = env[name] ?? (modifier === "?" ? "" : `\${${name}}`);
    if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
    return escapes.slice(escapes.length / 2) + replacement;
  });
  return { text, unset };
}

/** @param {unknown} error */
function errorCode(error) {
  return /** @type {NodeJS.ErrnoException} */ (error).code ?? "unknown error";
}

/**
 * @param {string} path
 * @param {string[]} warnings
 * @returns {Promise<Record<string, unknown>>}
 */
async function readNpmrc(path, warnings) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    // Like npm, continue without the file. Name the path and code only, never the contents.
    warnings.push(
      `Could not read the npm configuration file ${path} (${errorCode(error)}), so Calavera skipped it.`,
    );
    return {};
  }
  return decode(text);
}

/** @param {NodeJS.ProcessEnv} env */
function environmentSettings(env) {
  /** @type {Record<string, unknown>} */
  const settings = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^npm_config_/i.test(name) || !value) continue;
    let key = name.slice("npm_config_".length);
    // Nerf-darted keys keep their case and underscores; every other key is kebab-case.
    if (!key.startsWith("//")) key = key.replace(/(?!^)_/g, "-").toLowerCase();
    settings[key] = value;
  }
  return settings;
}

/** @param {NodeJS.ProcessEnv} env @param {string} home */
function userConfigPath(env, home) {
  const configured = environmentSettings(env).userconfig;
  if (typeof configured !== "string") return join(home, ".npmrc");
  const { text } = expandEnvironment(configured, env);
  const homePattern = process.platform === "win32" ? /^~(\/|\\)/ : /^~\//;
  return homePattern.test(text) ? resolve(home, text.slice(2)) : resolve(text);
}

/**
 * Load the registry and auth settings that npm would apply to a request, in the option names
 * pacote and npm-registry-fetch read: `registry`, the registry of `scope`, and nerf-darted auth
 * keys. Registries of other scopes are not read, so a broken one cannot stop an unrelated install.
 *
 * `${VAR}` is expanded in keys and values of the user .npmrc and the environment only. A project
 * .npmrc is repository content and must not read the caller's environment, so an entry of it that
 * contains `${` is ignored. `warnings` are for the user. `diagnostics` hold every ignored entry
 * and unset variable, for failure messages. `unsetVariables` lists variable names. None of them ever contains a value.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, scope?: string }} [context]
 * @returns {Promise<{ options: Record<string, string>, registry: EffectiveRegistry, warnings: string[], diagnostics: string[], unsetVariables: string[] }>}
 */
export async function loadNpmRegistryOptions({
  cwd = process.cwd(),
  env = process.env,
  scope,
} = {}) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Set<string>} */
  const unsetVariables = new Set();
  const home = env.HOME || homedir();
  const userPath = userConfigPath(env, home);
  const projectPath = resolve(cwd, ".npmrc");
  const scopeKey = scope ? `${scope}:registry` : undefined;
  /** @param {string} key */
  const isRegistryKey = (key) => key === "registry" || key === scopeKey;

  /** @type {{ name: Layer, entries: Record<string, unknown>, trusted: boolean }[]} */
  const layers = [
    { name: "user .npmrc", entries: await readNpmrc(userPath, warnings), trusted: true },
    {
      name: "project .npmrc",
      // npm ignores a project .npmrc that is the user config, as in a project at the home directory.
      entries: projectPath === userPath ? {} : await readNpmrc(projectPath, warnings),
      trusted: false,
    },
    { name: "environment", entries: environmentSettings(env), trusted: true },
  ];

  /** @type {Record<string, string>} */
  const options = {};
  /** @type {Record<string, Layer>} */
  const sources = {};
  for (const { name, entries, trusted } of layers) {
    for (const [rawKey, rawValue] of Object.entries(entries)) {
      if (typeof rawValue !== "string") continue;
      if (!trusted) {
        if (!isRegistryKey(rawKey) && !AUTH_KEY.test(rawKey)) continue;
        if (rawKey.includes("${") || rawValue.includes("${")) {
          const message = `Ignored ${rawKey} in the ${name}: Calavera expands \${...} only in the user .npmrc and npm_config_* variables, never in a project file.`;
          warnings.push(message);
          notes.push(message);
          continue;
        }
      }
      const expandedKey = expandEnvironment(rawKey, env);
      if (!isRegistryKey(expandedKey.text) && !AUTH_KEY.test(expandedKey.text)) continue;
      const expandedValue = expandEnvironment(rawValue.trim(), env);
      const unset = [...expandedKey.unset, ...expandedValue.unset];
      if (unset.length > 0) {
        // An entry that references an unset variable is absent. Sending the placeholder text as a
        // credential would only fail later with a misleading authentication error.
        for (const variable of unset) unsetVariables.add(variable);
        notes.push(
          `Ignored ${rawKey} in the ${name}: environment variable ${[...new Set(unset)].join(", ")} is not set.`,
        );
        continue;
      }
      const key = expandedKey.text;
      const value = expandedValue.text;
      if (isRegistryKey(key)) {
        if (!value) {
          const message = `Ignored ${key} in the ${name} because it is empty.`;
          warnings.push(message);
          notes.push(message);
          continue;
        }
        assertRegistryUrl(key, value);
      }
      options[key] = value;
      sources[key] = name;
    }
  }

  const registryKey = scopeKey && options[scopeKey] ? scopeKey : "registry";
  const url = options[registryKey] ?? DEFAULT_REGISTRY;
  return {
    options,
    registry: { host: new URL(url).host, source: sources[registryKey] ?? "default" },
    warnings,
    diagnostics: [...new Set([...warnings, ...notes])],
    unsetVariables: [...unsetVariables],
  };
}

/** @param {string} key @param {string} value */
function assertRegistryUrl(key, value) {
  // The value is never echoed: a registry URL can carry credentials.
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`The npm configuration key ${key} must be an http or https URL.`);
  }
  const { username, password } = new URL(value);
  if (username || password) {
    throw new Error(
      `The npm configuration key ${key} must not include a username or password in the URL. Set credentials with //host/:_authToken, //host/:_auth, or //host/:username and //host/:_password instead.`,
    );
  }
}
