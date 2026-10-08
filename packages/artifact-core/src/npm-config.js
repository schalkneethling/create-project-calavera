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
const REGISTRY_KEY = /^(?:registry|@[^/:]+:registry)$/;
// Nerf-darted keys such as //registry.example.com/:_authToken, as read by npm-registry-fetch.
const AUTH_KEY = /^\/\/.+:(?:_authToken|_auth|username|_password|certfile|keyfile)$/;
// Same expression as @npmcli/config: ${VAR}, ${VAR?} for an empty fallback, and backslash escapes.
const ENV_EXPRESSION = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;

/** @param {string} value @param {NodeJS.ProcessEnv} env */
function expandEnvironment(value, env) {
  return value.replace(ENV_EXPRESSION, (original, escapes, name, modifier) => {
    const replacement = env[name] ?? (modifier === "?" ? "" : `\${${name}}`);
    if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
    return escapes.slice(escapes.length / 2) + replacement;
  });
}

/** @param {string} path @returns {Promise<Record<string, unknown>>} */
async function readNpmrc(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return {};
    // Name the file and error code only. Never include file contents.
    throw new Error(
      `Could not read npm configuration ${path} (${/** @type {NodeJS.ErrnoException} */ (error).code ?? "unknown error"}).`,
      { cause: error },
    );
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

/**
 * Load the registry and auth settings that npm would apply to a request, in the option names
 * pacote and npm-registry-fetch read: `registry`, `@scope:registry`, and nerf-darted auth keys.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [context]
 * @returns {Promise<Record<string, string>>}
 */
export async function loadNpmRegistryOptions({ cwd = process.cwd(), env = process.env } = {}) {
  const environment = environmentSettings(env);
  const userConfigPath = resolve(
    typeof environment.userconfig === "string"
      ? environment.userconfig
      : join(env.HOME ?? homedir(), ".npmrc"),
  );
  const projectConfigPath = resolve(cwd, ".npmrc");

  const layers = [
    await readNpmrc(userConfigPath),
    // npm ignores a project .npmrc that is the user config, as in a project at the home directory.
    projectConfigPath === userConfigPath ? {} : await readNpmrc(projectConfigPath),
    environment,
  ];

  /** @type {Record<string, string>} */
  const options = {};
  for (const layer of layers) {
    for (const [key, raw] of Object.entries(layer)) {
      const isRegistry = REGISTRY_KEY.test(key);
      if ((!isRegistry && !AUTH_KEY.test(key)) || typeof raw !== "string") continue;
      const value = expandEnvironment(raw.trim(), env);
      if (isRegistry) {
        options[key] = validRegistry(key, value);
      } else if (value.includes("${")) {
        // A credential that references an unset variable is absent. Sending the placeholder
        // text as a token would only fail later with a misleading authentication error.
        delete options[key];
      } else {
        options[key] = value;
      }
    }
  }
  return options;
}

/** @param {string} key @param {string} value */
function validRegistry(key, value) {
  // The value is never echoed: a registry URL can carry credentials.
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`The npm configuration key ${key} must be an http or https URL.`);
  }
  return value;
}
