// @ts-check
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { decode } from "ini";

import { printable, readConfigText } from "./config-files.js";
import {
  YARN_DEFAULT_REGISTRY,
  bunEnvironmentLayer,
  bunfigLayers,
  detectLauncher,
  yarnLayers,
} from "./launcher-config.js";

/** @typedef {import("./launcher-config.js").Launcher} Launcher */

// pacote and npm-registry-fetch do not read .npmrc files. The npm CLI loads them with
// @npmcli/config and passes the result as options. This loader reproduces only the part that
// decides where a request goes and through which proxy, with npm's precedence for those keys: user .npmrc, then project .npmrc, then npm_config_* environment
// variables. Global and built-in npmrc files, command-line flags, and other settings (CA) are not
// read. The project .npmrc is the one in `cwd`, or, when npm started Calavera, the one at npm's
// local prefix, which is the file npm itself read.
// Under Yarn 2 or later and Bun, the registry comes from their own settings; see
// launcher-config.js.
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
// The .npmrc proxy keys (@npmcli/config definitions). npm flattens them to `proxy`, `httpsProxy`,
// and `noProxy`, which npm-registry-fetch passes to @npmcli/agent as
// `proxy: opts.httpsProxy || opts.proxy` and `noProxy`.
const NPM_PROXY_KEYS = new Set(["proxy", "https-proxy", "noproxy"]);
// The internal keys of Yarn's httpProxy and httpsProxy; see launcher-config.js.
const PROXY_URL_KEYS = new Set(["proxy", "https-proxy", "yarn-http-proxy", "yarn-https-proxy"]);
// The proxy protocols @npmcli/agent accepts (`getProxyAgent` and SocksProxyAgent.protocols).
const PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);
// Same expression as @npmcli/config: ${VAR}, ${VAR?} for an empty fallback, and backslash escapes.
const ENV_EXPRESSION = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;

/**
 * @typedef {string} Layer A configuration source, such as "user .npmrc" or "project bunfig.toml".
 * @typedef {{ origin: string, source: Layer | "default", setting: string | null }} EffectiveRegistry
 *   `setting` names the setting that chose the registry, such as `@schalkneethling:registry` or
 *   `npmScopes.schalkneethling.npmRegistryServer`, and is null for the default registry. It is for
 *   messages only; the CLI's registry output keeps `origin` and `source`.
 * @typedef {import("./launcher-config.js").LauncherLayer & { accepts?: (key: string) => boolean, npmEnvironment?: boolean }} ConfigLayer
 */

/**
 * Whether npm started this process, as `npx`, `npm exec`, or `npm run` do. npm then exports its
 * resolved configuration as npm_config_* variables, with project .npmrc values already expanded.
 * All three markers are set by `npm exec` and `npm run`; any one is enough.
 * @param {NodeJS.ProcessEnv} env
 */
function startedByNpm(env) {
  return Boolean(env.npm_command || env.npm_lifecycle_event || env.npm_config_local_prefix);
}

/**
 * Expands variables like @npmcli/config. A variable that is not set is left in place and listed.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 */
function expandEnvironment(value, env) {
  /** @type {string[]} */
  const unset = [];
  const text = value.replace(ENV_EXPRESSION, (original, escapes, name, modifier) => {
    if (env[name] === undefined && modifier !== "?" && escapes.length % 2 === 0) {
      unset.push(printable(name));
    }
    const replacement = env[name] ?? (modifier === "?" ? "" : `\${${name}}`);
    if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
    return escapes.slice(escapes.length / 2) + replacement;
  });
  return { text, unset };
}

/**
 * @param {string} path
 * @param {string[]} warnings
 * @returns {Promise<Record<string, unknown>>}
 */
async function readNpmrc(path, warnings) {
  const text = await readConfigText(path, "npm configuration file", warnings);
  return text === undefined ? {} : decode(text);
}

/** @param {NodeJS.ProcessEnv} env */
function environmentSettings(env) {
  /** @type {Record<string, unknown>} */
  const settings = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^npm_config_/i.test(name) || !value) continue;
    const key = name
      .slice("npm_config_".length)
      .replace(/(?!^)_/g, "-")
      .toLowerCase();
    // npm exports a list setting joined with blank lines (`envVal` in @npmcli/config
    // set-envs.js), but @npmcli/agent splits noProxy on commas only.
    settings[key] = key === "noproxy" ? value.split("\n\n").join(",") : value;
  }
  return settings;
}

/**
 * The key of `entries` whose value a package manager exported as the variable for `key`, if any.
 * A variable name keeps only letters, digits, and underscores, so other spellings of a key, such
 * as https_proxy or HTTPS-PROXY, export under the same name.
 * @param {Record<string, unknown>} entries
 * @param {string} key
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} [otherSpellings] Whether keys spelled differently match.
 */
function exportedFrom(entries, key, value, env, otherSpellings = true) {
  return Object.keys(entries).find((fileKey) => {
    const fileValue = entries[fileKey];
    return (
      (otherSpellings ? normalizedKey(fileKey) : fileKey) === key &&
      typeof fileValue === "string" &&
      expandEnvironment(fileValue.trim(), env).text === value.trim()
    );
  });
}

/**
 * The user .npmrc. Bun also reads `$XDG_CONFIG_HOME/.npmrc` when it exists and no userconfig is
 * set (https://bun.com/docs/install/npmrc).
 * @param {NodeJS.ProcessEnv} env @param {string} home @param {Launcher} launcher
 */
async function userConfigPath(env, home, launcher) {
  const configured = environmentSettings(env).userconfig;
  if (typeof configured === "string") {
    const { text } = expandEnvironment(configured, env);
    const homePattern = process.platform === "win32" ? /^~(\/|\\)/ : /^~\//;
    return homePattern.test(text) ? resolve(home, text.slice(2)) : resolve(text);
  }
  if (launcher === "bun" && env.XDG_CONFIG_HOME) {
    const xdgPath = resolve(env.XDG_CONFIG_HOME, ".npmrc");
    if (
      await access(xdgPath).then(
        () => true,
        () => false,
      )
    )
      return xdgPath;
  }
  return join(home, ".npmrc");
}

/**
 * Load the registry and proxy settings that the package manager that started Calavera would apply
 * to a request, in the option names pacote and npm-registry-fetch read: `registry`, the registry
 * of `scope`, `proxy`, `httpsProxy`, and `noProxy`. Every other key is dropped as each layer is
 * read, so no registry credential (`//host/:_authToken`, `_auth`, `username`, `_password`,
 * `certfile`, or `keyfile`) is read, expanded, returned, or named (ADR-0021). Registries of other
 * scopes are not read, so a broken one cannot stop an unrelated install.
 *
 * Under npm and pnpm, the settings come from the .npmrc files and npm_config_* variables. Yarn 1
 * counts as npm here, unchanged by #1064; #1175 removes its support.
 * Under Yarn 2 or later, they come from .yarnrc.yml files and YARN_* variables only, and no .npmrc
 * file or npm_config_* variable is read. Under Bun, the bunfig.toml registry and then the first
 * valid of BUN_CONFIG_REGISTRY, NPM_CONFIG_REGISTRY, and npm_config_registry override the .npmrc
 * registry, and the .npmrc proxy keys are not read, because Bun does not support them.
 *
 * A registry value is never expanded: one that holds a variable reference stops the command, and
 * a username and password in a registry URL are removed with a warning. `${VAR}` is expanded in
 * proxy values of user files and the environment only. A project file is repository content and
 * must not read the caller's environment, so a proxy value of it that contains `${` is ignored,
 * and so is a proxy it sets.
 * `warnings` are for the user. `diagnostics` hold every ignored entry and unset variable, for
 * failure messages. `unsetVariables` lists variable names. None of them ever contains a value.
 * `registryUrl` is the URL of the registry that serves `scope`, without user information.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, scope?: string }} [context]
 * @returns {Promise<{ options: Record<string, string>, registry: EffectiveRegistry, registryUrl: string, warnings: string[], diagnostics: string[], unsetVariables: string[] }>}
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
  const launcher = detectLauncher(env);
  // npm exports the .npmrc settings it resolved as npm_config_* variables, so the comparison with
  // exported values below applies under it. pnpm counts as npm here, but pnpm 12 exports no
  // settings, so the comparison finds nothing. Bun and Yarn 2 or later also set
  // npm_lifecycle_event and similar variables, but read their own settings.
  const npmStarted = launcher === "npm" && startedByNpm(env);
  const scopeKey = scope ? `${scope}:registry` : undefined;
  /** @param {string} key */
  const isRegistryKey = (key) => key === "registry" || key === scopeKey;
  // The keys each launcher reads from .npmrc files and npm_config_* variables. Yarn 2 or later
  // reads neither, so they are not read under it at all.
  const accepts =
    launcher === "bun"
      ? isRegistryKey
      : (/** @type {string} */ key) => isRegistryKey(key) || NPM_PROXY_KEYS.has(key);

  /** @type {Record<string, unknown>} */
  let userEntries = {};
  /** @type {Record<string, unknown>} */
  let projectEntries = {};
  const launcherContext = { cwd, env, home, scope, warnings };
  /** @type {ConfigLayer[]} */
  let layers;
  if (launcher === "yarn") {
    layers = await yarnLayers(launcherContext);
  } else {
    // npm reads the project .npmrc at its local prefix: the nearest folder above the working
    // directory with a package.json or node_modules, or the workspace root of a member
    // (`loadLocalPrefix` and `loadProjectConfig` in @npmcli/config). It exports that folder as
    // npm_config_local_prefix (`setEnvs`), and the file's values as npm_config_* variables.
    // Reading the same file keeps those values labeled, and restricted, as project content.
    const projectPath = resolve((npmStarted && env.npm_config_local_prefix) || cwd, ".npmrc");
    const userPath = await userConfigPath(env, home, launcher);
    userEntries = await readNpmrc(userPath, warnings);
    // npm ignores a project .npmrc that is the user config, as in a project at the home directory.
    projectEntries = projectPath === userPath ? {} : await readNpmrc(projectPath, warnings);
    /** @type {ConfigLayer[]} */
    const npmFiles = [
      { name: "user .npmrc", entries: userEntries, trusted: true, accepts },
      { name: "project .npmrc", entries: projectEntries, trusted: false, accepts },
    ];
    /** @type {ConfigLayer} */
    const npmEnvironment = {
      name: "environment",
      entries: environmentSettings(env),
      trusted: true,
      // Under Bun, bunEnvironmentLayer reads the registry variables in Bun's own order.
      accepts: launcher === "bun" ? (key) => key !== "registry" && accepts(key) : accepts,
      npmEnvironment: true,
    };
    layers =
      launcher === "bun"
        ? [
            ...npmFiles,
            ...(await bunfigLayers(launcherContext)),
            npmEnvironment,
            bunEnvironmentLayer(env),
          ]
        : [...npmFiles, npmEnvironment];
  }

  /** @type {Record<string, string>} */
  const options = {};
  /** @type {Record<string, ConfigLayer>} */
  const sources = {};
  /** @type {{ key: string, setting: string, layer: string }[]} */
  const rejectedProxies = [];
  for (const layer of layers) {
    const { name, entries, trusted } = layer;
    for (const [key, entry] of Object.entries(entries)) {
      // The allowlist comes first, so the value of any other key, such as a credential, is never
      // looked at. Launcher layers hold only the keys Calavera reads.
      if (layer.accepts && !layer.accepts(key)) continue;
      // npm accepts noproxy as a list (noproxy[]=host) and joins it with commas.
      const rawValue = key === "noproxy" && Array.isArray(entry) ? entry.join(",") : entry;
      if (typeof rawValue !== "string") continue;
      const setting = printable(layer.settingNames?.[key] ?? key);
      if (layer.npmEnvironment && npmStarted) {
        // npm exports its resolved settings, and for a project .npmrc value it exports the
        // result of its own ${VAR} expansion. Such a value is project content, not
        // environment, so it follows the project rules and keeps its label. npm exports a key
        // written in another spelling, such as https_proxy, under the same variable, so the
        // comparison normalizes the file's keys as the variable names are normalized. The
        // file's value is expanded only for this comparison, never used as a registry.
        const projectKey = exportedFrom(projectEntries, key, rawValue, env);
        if (projectKey !== undefined) {
          // The project layer already applied it, ignored it with a warning, or stopped,
          // unless the file spells the key differently.
          if (projectKey !== key && PROXY_URL_KEYS.has(key)) {
            rejectedProxies.push({ key, setting: printable(projectKey), layer: "project .npmrc" });
          }
          continue;
        }
        // A value equal to the user .npmrc value under the same key was applied by the user
        // layer, or ignored or stopped there.
        if (exportedFrom(userEntries, key, rawValue, env, false) !== undefined) continue;
      }
      if (isRegistryKey(key)) {
        const value = registryValue(setting, rawValue.trim(), layer, warnings);
        if (value === undefined) continue;
        options[key] = value;
        sources[key] = layer;
        continue;
      }
      if (!trusted) {
        if (rawValue.includes("${")) {
          const message = `Ignored ${setting} in the ${name}: Calavera expands variables only in user configuration files and environment variables, never in a project file.`;
          warnings.push(message);
          notes.push(message);
          continue;
        }
        // A project file could name a proxy it controls, which would see which packages Calavera
        // fetches and, for an http registry, could replace the package documents and tarballs
        // together. The entry is skipped here, so it never replaces a proxy from a user file. An
        // empty value and a noproxy entry only remove the proxy, so a project file may still set
        // them. The warning is written after every layer is read, so it names the proxy that
        // applies.
        if (PROXY_URL_KEYS.has(key) && rawValue.trim()) {
          rejectedProxies.push({ key, setting, layer: name });
          continue;
        }
      }
      /** @type {import("./launcher-config.js").Expansion} */
      const expanded = layer.expand
        ? layer.expand(rawValue.trim(), env)
        : expandEnvironment(rawValue.trim(), env);
      if (expanded.unset.length > 0) {
        // An entry that references an unset variable is absent, rather than sent with the
        // placeholder text.
        for (const variable of expanded.unset) unsetVariables.add(variable);
        notes.push(
          `Ignored ${setting} in the ${name}: environment variable ${[...new Set(expanded.unset)].join(", ")} is not set.`,
        );
        continue;
      }
      const value = expanded.text;
      if (PROXY_URL_KEYS.has(key) && value && !isProxyUrl(value)) {
        // The value is never echoed: a proxy URL can carry credentials.
        const message = `Ignored ${setting} in the ${name}: it must be an http, https, or socks proxy URL.`;
        warnings.push(message);
        notes.push(message);
        continue;
      }
      options[key] = value;
      sources[key] = layer;
    }
  }

  if (launcher === "yarn" && !options.registry) options.registry = YARN_DEFAULT_REGISTRY;
  const registryKey = scopeKey && options[scopeKey] ? scopeKey : "registry";
  const registryUrl = new URL(options[registryKey] ?? DEFAULT_REGISTRY);
  // The option each proxy key becomes. Yarn uses httpsProxy for https requests and httpProxy for
  // http requests, so only the one for the registry protocol is kept.
  const proxyNames = new Map(
    launcher === "yarn"
      ? [[registryUrl.protocol === "https:" ? "yarn-https-proxy" : "yarn-http-proxy", "proxy"]]
      : [
          ["proxy", "proxy"],
          ["https-proxy", "httpsProxy"],
          ["noproxy", "noProxy"],
        ],
  );
  /** @type {Record<string, string>} */
  const proxyOrigins = {};
  for (const key of new Set([...NPM_PROXY_KEYS, ...PROXY_URL_KEYS])) {
    const value = options[key];
    const layer = sources[key];
    delete options[key];
    const name = proxyNames.get(key);
    // An empty value leaves the proxy unset, as an empty npm setting does.
    if (!name || !value || !layer) continue;
    options[name] = value;
    proxyOrigins[name] = `${printable(layer.settingNames?.[key] ?? key)} from the ${layer.name}`;
  }
  // The warning for an ignored project proxy names the proxy that requests use after every layer
  // is read: npm-registry-fetch uses httpsProxy when it is set and proxy otherwise.
  // Without one, @npmcli/agent falls back to the proxy environment variables, in either letter
  // case: https_proxy for an https registry, and https_proxy, http_proxy, or proxy for http
  // (`getProxy` in @npmcli/agent/lib/proxy.js).
  const environmentProxy = (
    registryUrl.protocol === "https:" ? ["https_proxy"] : ["https_proxy", "http_proxy", "proxy"]
  )
    .map((wanted) => Object.keys(env).find((name) => name.toLowerCase() === wanted && env[name]))
    .find(Boolean);
  const usedProxy = registryBypassesProxy(registryUrl, options.noProxy, env)
    ? "direct"
    : (proxyOrigins[options.httpsProxy ? "httpsProxy" : "proxy"] ??
      (environmentProxy ? `the ${printable(environmentProxy)} environment variable` : undefined));
  const registryProtocol = registryUrl.protocol.slice(0, -1);
  const userFile = launcher === "yarn" ? "your user .yarnrc.yml" : "your user .npmrc";
  for (const { key, setting, layer } of rejectedProxies) {
    const used =
      usedProxy === "direct"
        ? "The registry host is excluded from proxies, so requests go to it directly."
        : usedProxy
          ? `Calavera uses ${usedProxy} instead.`
          : undefined;
    // Under Yarn, a proxy for the other protocol would not apply even from a user file.
    const outcome =
      launcher === "yarn" && !proxyNames.has(key)
        ? [
            `Yarn uses it only for ${key === "yarn-http-proxy" ? "http" : "https"} registries, and the registry is ${registryProtocol}.`,
            used,
          ]
            .filter(Boolean)
            .join(" ")
        : (used ?? `No other proxy setting applies. To use it, set it in ${userFile}.`);
    const message = `Ignored ${setting} in the ${layer}: Calavera reads proxies only from user configuration files and environment variables. ${outcome}`;
    warnings.push(message);
    notes.push(message);
  }
  return {
    options,
    registry: {
      origin: registryUrl.origin,
      source: sources[registryKey]?.name ?? "default",
      setting: sources[registryKey]
        ? printable(sources[registryKey].settingNames?.[registryKey] ?? registryKey)
        : null,
    },
    registryUrl: registryUrl.href,
    warnings,
    diagnostics: [...new Set([...warnings, ...notes])],
    unsetVariables: [...unsetVariables],
  };
}

/**
 * Whether @npmcli/agent sends requests to the registry without a proxy: a configured noProxy
 * replaces the no_proxy variable (any letter case), and an entry matches a host whose trailing
 * name segments equal it (`getProxy` and `isNoProxy` in @npmcli/agent/lib/proxy.js).
 * @param {URL} registryUrl
 * @param {string | undefined} configured
 * @param {NodeJS.ProcessEnv} env
 */
function registryBypassesProxy(registryUrl, configured, env) {
  const list =
    configured ||
    Object.entries(env).find(([name, value]) => name.toLowerCase() === "no_proxy" && value)?.[1];
  if (!list) return false;
  const hostSegments = registryUrl.hostname.split(".").reverse();
  return list
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => {
      const segments = entry.split(".").filter(Boolean).reverse();
      return (
        segments.length > 0 && segments.every((segment, index) => hostSegments[index] === segment)
      );
    });
}

/**
 * A key as npm names its variable, back in key form: other spellings, such as https_proxy or
 * HTTPS-PROXY, become https-proxy.
 * @param {string} key
 */
function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

/**
 * The URL pacote fetches for a tarball. Unless told otherwise, pacote moves a tarball on
 * registry.npmjs.org onto the `registry` option, keeping the tarball's path and dropping any path
 * of the registry URL (`replaceRegistryHost` in pacote/lib/fetcher.js and lib/remote.js).
 * extractArtifactPackage passes the artifact scope's registry as that option, so the lookup and
 * the download use the same registry (ADR-0021 Decision 4). A check on the downloaded URL must
 * judge this URL, not the one the package document names.
 * @param {string} resolved
 * @param {string} registry The registry pacote is given, the artifact scope's registry.
 */
export function pacoteTarballUrl(resolved, registry) {
  if (!URL.canParse(resolved)) return resolved;
  const url = new URL(resolved);
  if (url.host !== "registry.npmjs.org") return resolved;
  return new URL(url.pathname, registry.replace(/\/+$/, "")).href;
}

/** @param {string} value */
function isProxyUrl(value) {
  return URL.canParse(value) && PROXY_PROTOCOLS.has(new URL(value).protocol);
}

/**
 * How a message names a setting: "The npm configuration key registry" or "The Yarn setting
 * npmRegistryServer", and where it came from.
 * @param {string} setting The key or setting name, as the person wrote it.
 * @param {ConfigLayer} layer
 */
function describeSetting(setting, layer) {
  const subject = layer.tool
    ? `The ${layer.tool} setting ${setting}`
    : `The npm configuration key ${setting}`;
  return { subject, where: layer.name === "environment" ? "" : ` in the ${layer.name}` };
}

/**
 * The registry URL to use for a registry setting, or undefined when the setting is empty. The
 * value is never echoed, because a registry URL can carry a secret. A value with a variable
 * reference stops the command: Calavera never expands a registry value, and falling back to
 * another layer would bypass a registry the person configured (ADR-0021 Decision 2). A username
 * and password in the URL are removed with a warning, because Calavera sends no credentials, and
 * minipass-fetch would turn them into basic authentication.
 * @param {string} setting
 * @param {string} value
 * @param {ConfigLayer} layer
 * @param {string[]} warnings
 */
function registryValue(setting, value, layer, warnings) {
  const { subject, where } = describeSetting(setting, layer);
  // Bun expands a value that starts with $ (`Scope.fromAPI` in Bun's src/install/npm.zig); npm
  // and Yarn expand ${NAME}.
  if (layer.tool === "Bun" ? value.startsWith("$") : value.includes("${")) {
    const layerName = layer.name === "environment" ? " in the environment" : where;
    throw new Error(
      `${subject}${layerName} contains a variable reference. Calavera does not expand variables in a registry URL, because a variable there can carry a secret. Write the registry URL without a variable.`,
    );
  }
  if (!value) {
    warnings.push(`Ignored ${setting} in the ${layer.name} because it is empty.`);
    return undefined;
  }
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`${subject}${where} must be an http or https URL.`);
  }
  const url = new URL(value);
  if (!layer.trusted && url.protocol !== "https:") {
    // A package's integrity comes from the same package document as its tarball, so on an http
    // registry anyone on the network path can replace both together, and the artifact still
    // passes verification. A person may choose that in their own configuration, but a cloned
    // repository may not choose it for them.
    throw new Error(
      `${subject}${where} must be an https URL. To use an http registry, set it in your user configuration.`,
    );
  }
  if (!url.username && !url.password) return value;
  url.username = "";
  url.password = "";
  const layerName =
    layer.name === "environment" ? " from the environment" : ` from the ${layer.name}`;
  warnings.push(
    `Used ${setting}${layerName} without the username and password in its URL: Calavera sends no credentials to any registry.`,
  );
  return url.href;
}
