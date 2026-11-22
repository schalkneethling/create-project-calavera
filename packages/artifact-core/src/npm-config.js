// @ts-check
import { access } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
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
// decides where a request goes, through which proxy, and how it authenticates, with npm's
// precedence for those keys: user .npmrc, then project .npmrc, then npm_config_* environment
// variables. Global and built-in npmrc files, command-line flags, and other settings (CA) are not
// read. The project .npmrc is the one in `cwd`, or, when npm started Calavera, the one at npm's
// local prefix, which is the file npm itself read.
// Under Yarn 2 or later and Bun, the registry comes from their own settings; see
// launcher-config.js.
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
// Nerf-darted keys such as //registry.example.com/:_authToken, as read by npm-registry-fetch.
const AUTH_KEY = /^\/\/.+:(?:_authToken|_auth|username|_password|certfile|keyfile)$/;
// Certificate files name paths on this machine, so only the user .npmrc may set them.
const CERTIFICATE_KEY = /:(?:certfile|keyfile)$/;
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
// How warnings name the account's own user .npmrc, the only source of credentials when a package
// manager starts Calavera.
const ACCOUNT_NPMRC = "~/.npmrc";
// Same expression as @npmcli/config: ${VAR}, ${VAR?} for an empty fallback, and backslash escapes.
const ENV_EXPRESSION = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;

/**
 * @typedef {string} Layer A configuration source, such as "user .npmrc" or "project bunfig.toml".
 * @typedef {{ origin: string, source: Layer | "default" }} EffectiveRegistry
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
    let key = name.slice("npm_config_".length);
    // Nerf-darted keys keep their case and underscores; every other key is kebab-case.
    if (!key.startsWith("//")) key = key.replace(/(?!^)_/g, "-").toLowerCase();
    // npm exports a list setting joined with blank lines (`envVal` in @npmcli/config
    // set-envs.js), but @npmcli/agent splits noProxy on commas only.
    settings[key] = key === "noproxy" ? value.split("\n\n").join(",") : value;
  }
  return settings;
}

/**
 * The key of `entries` whose value a package manager exported as the variable for `key`, if any.
 * A variable name keeps only letters, digits, and underscores, so other spellings of a key, such
 * as https_proxy or HTTPS-PROXY, export under the same name. Nerf-darted keys are never exported.
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
      !fileKey.startsWith("//") &&
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
 * Load the registry, proxy, and auth settings that the package manager that started Calavera
 * would apply to a request, in the option names pacote and npm-registry-fetch read: `registry`,
 * the registry of `scope`, `proxy`, `httpsProxy`, `noProxy`, and nerf-darted auth keys. Registries
 * of other scopes are not read, so a broken one cannot stop an unrelated install.
 *
 * Under npm and pnpm, the settings come from the .npmrc files and npm_config_* variables. Yarn 1
 * counts as npm here, unchanged by #1064; #1175 removes its support.
 * Under Yarn 2 or later, the registry and proxy come from .yarnrc.yml files and YARN_* variables,
 * and only the auth keys from the .npmrc files, because Yarn does not read them. Under Bun, the
 * bunfig.toml registry and then the first valid of BUN_CONFIG_REGISTRY, NPM_CONFIG_REGISTRY,
 * and npm_config_registry override the .npmrc registry, and the .npmrc proxy
 * keys are not read, because Bun does not support them.
 *
 * `${VAR}` is expanded in keys and values of user files and the environment only. A project file
 * is repository content and must not read the caller's environment, so an entry of it that
 * contains `${` is ignored, and so is a proxy it sets.
 * `warnings` are for the user. `diagnostics` hold every ignored entry and unset variable, for
 * failure messages. `unsetVariables` lists variable names. None of them ever contains a value.
 * `accountHome` replaces the operating system account's home folder, for tests only.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, scope?: string, accountHome?: string }} [context]
 * @returns {Promise<{ options: Record<string, string>, registry: EffectiveRegistry, warnings: string[], diagnostics: string[], unsetVariables: string[] }>}
 */
export async function loadNpmRegistryOptions({
  cwd = process.cwd(),
  env = process.env,
  scope,
  accountHome,
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
  // npm reads the project .npmrc at its local prefix: the nearest folder above the working
  // directory with a package.json or node_modules, or the workspace root of a member
  // (`loadLocalPrefix` and `loadProjectConfig` in @npmcli/config). It exports that folder as
  // npm_config_local_prefix (`setEnvs`), and the file's values as npm_config_* variables.
  // Reading the same file keeps those values labeled, and restricted, as project content.
  const projectPath = resolve((npmStarted && env.npm_config_local_prefix) || cwd, ".npmrc");
  const userPath = await userConfigPath(env, home, launcher);
  // Invariant 2: when a package manager starts Calavera, the environment can carry repository
  // content (npm exports project settings, a project can set userconfig or user-agent, and Yarn 4
  // injects a committed .env.yarn). Credentials, and the ${VAR} expansion inside them, then come
  // only from the account's own ~/.npmrc, with the home folder taken from the operating system
  // account rather than HOME. Every other layer's credential keys are ignored with a warning.
  // Yarn 4 sets no lifecycle variable for `yarn <bin>` or `yarn exec`, but every package manager
  // sets npm_execpath or npm_config_user_agent. Spoofing either only makes Calavera stricter.
  const credentialsLocked =
    startedByNpm(env) || Boolean(env.npm_execpath || env.npm_config_user_agent);
  const credentialHome = (accountHome ?? accountHomeFolder()) || undefined;
  const credentialPath = credentialHome === undefined ? undefined : join(credentialHome, ".npmrc");
  const scopeKey = scope ? `${scope}:registry` : undefined;
  /** @param {string} key */
  const isRegistryKey = (key) => key === "registry" || key === scopeKey;
  /** @type {Record<Launcher, (key: string) => boolean>} */
  const npmKeys = {
    npm: (key) => isRegistryKey(key) || AUTH_KEY.test(key) || NPM_PROXY_KEYS.has(key),
    bun: (key) => isRegistryKey(key) || AUTH_KEY.test(key),
    yarn: (key) => AUTH_KEY.test(key),
  };
  const accepts = npmKeys[launcher];

  const userEntries = await readNpmrc(userPath, warnings);
  // npm ignores a project .npmrc that is the user config, as in a project at the home directory.
  const projectEntries = projectPath === userPath ? {} : await readNpmrc(projectPath, warnings);
  /** @type {ConfigLayer[]} */
  const npmFiles = [
    { name: "user .npmrc", entries: userEntries, trusted: true, accepts },
    { name: "project .npmrc", entries: projectEntries, trusted: false, accepts },
  ];
  /** @type {ConfigLayer | undefined} */
  let credentialLayer;
  if (credentialsLocked && credentialPath !== undefined) {
    if (credentialPath === userPath) {
      credentialLayer = npmFiles[0];
    } else {
      credentialLayer = {
        name: ACCOUNT_NPMRC,
        entries: await readNpmrc(credentialPath, warnings),
        trusted: true,
        accepts: (key) => AUTH_KEY.test(key),
      };
      npmFiles.push(credentialLayer);
    }
  }
  /** @type {ConfigLayer} */
  const npmEnvironment = {
    name: "environment",
    entries: environmentSettings(env),
    trusted: true,
    // Under Bun, bunEnvironmentLayer reads the registry variables in Bun's own order.
    accepts: launcher === "bun" ? (key) => key !== "registry" && accepts(key) : accepts,
    npmEnvironment: true,
  };
  const launcherContext = { cwd, env, home, scope, warnings, notes };
  /** @type {ConfigLayer[]} */
  const layers =
    launcher === "yarn"
      ? [...npmFiles, npmEnvironment, ...(await yarnLayers(launcherContext))]
      : launcher === "bun"
        ? [
            ...npmFiles,
            ...(await bunfigLayers(launcherContext)),
            npmEnvironment,
            bunEnvironmentLayer(env),
          ]
        : [...npmFiles, npmEnvironment];

  /** @type {Record<string, string>} */
  const options = {};
  /** @type {Record<string, ConfigLayer>} */
  const sources = {};
  /** @type {{ key: string, setting: string, layer: string }[]} */
  const rejectedProxies = [];
  for (const layer of layers) {
    const { name, entries, trusted } = layer;
    for (const [rawKey, entry] of Object.entries(entries)) {
      // npm accepts noproxy as a list (noproxy[]=host) and joins it with commas.
      const rawValue = rawKey === "noproxy" && Array.isArray(entry) ? entry.join(",") : entry;
      if (typeof rawValue !== "string") continue;
      const setting = printable(layer.settingNames?.[rawKey] ?? rawKey);
      if (layer.npmEnvironment && npmStarted) {
        // npm exports its resolved settings, and for a project .npmrc value it exports the
        // result of its own ${VAR} expansion. Such a value is project content, not
        // environment, so it follows the project rules and keeps its label. npm exports a key
        // written in another spelling, such as https_proxy, under the same variable, so the
        // comparison normalizes the file's keys as the variable names are normalized.
        const projectKey = exportedFrom(projectEntries, rawKey, rawValue, env);
        if (projectKey !== undefined) {
          // The project layer already applied it or ignored it with a warning, unless the file
          // spells the key differently.
          if (projectKey !== rawKey && PROXY_URL_KEYS.has(rawKey)) {
            rejectedProxies.push({
              key: rawKey,
              setting: printable(projectKey),
              layer: "project .npmrc",
            });
          }
          continue;
        }
        // A value equal to the user .npmrc value under the same key was applied by the user
        // layer, or ignored there with a warning.
        if (exportedFrom(userEntries, rawKey, rawValue, env, false) !== undefined) continue;
      }
      if (credentialsLocked && AUTH_KEY.test(rawKey) && layer !== credentialLayer) {
        // A variable in a credential key of the account file is handled after expansion, below.
        const reason =
          credentialPath === undefined
            ? `credentials come only from ${ACCOUNT_NPMRC}, and the home folder of the operating system account is unknown`
            : `credentials come only from ${ACCOUNT_NPMRC}, because the environment can carry repository content`;
        const message = `Ignored ${setting} in the ${name}: when a package manager starts Calavera, ${reason}.`;
        warnings.push(message);
        notes.push(message);
        continue;
      }
      if (!trusted) {
        if (layer.accepts && !layer.accepts(rawKey)) continue;
        // Bun expands a value that starts with $ (`Scope.fromAPI` in Bun's src/install/npm.zig).
        const bunVariable = layer.tool === "Bun" && rawValue.startsWith("$");
        if (rawKey.includes("${") || rawValue.includes("${") || bunVariable) {
          const message = `Ignored ${setting} in the ${name}: Calavera expands variables only in user configuration files and environment variables, never in a project file.`;
          warnings.push(message);
          notes.push(message);
          continue;
        }
        if (CERTIFICATE_KEY.test(rawKey)) {
          const message = `Ignored ${setting} in the ${name}: Calavera reads certificate files only from the user .npmrc.`;
          warnings.push(message);
          notes.push(message);
          continue;
        }
        // A project file could name a proxy it controls together with a registry whose package
        // documents point at http tarball URLs. npm-registry-fetch sends the credentials of a host
        // whatever the protocol, so the proxy would receive them in plain text. The entry is
        // skipped here, so it never replaces a proxy from a user file. An empty value and a
        // noproxy entry only remove the proxy, so a project file may still set them.
        // The warning is written after every layer is read, so it names the proxy that applies.
        if (PROXY_URL_KEYS.has(rawKey) && rawValue.trim()) {
          rejectedProxies.push({ key: rawKey, setting, layer: name });
          continue;
        }
      }
      // Launcher layers have fixed keys, so only .npmrc keys are expanded.
      const expandedKey = layer.expand
        ? { text: rawKey, unset: [] }
        : expandEnvironment(rawKey, env);
      if (layer.accepts && !layer.accepts(expandedKey.text)) continue;
      // A key that becomes a credential key only after expansion, such as //host/:${NAME}, is
      // held to the same rule as a written one, so the environment cannot build a credential.
      if (credentialsLocked && AUTH_KEY.test(expandedKey.text) && expandedKey.text !== rawKey) {
        const message = `Ignored ${setting} in the ${name}: when a package manager starts Calavera, Calavera does not expand variables in a credential key, because the environment can carry repository content.`;
        warnings.push(message);
        notes.push(message);
        continue;
      }
      /** @type {import("./launcher-config.js").Expansion} */
      const expandedValue = layer.expand
        ? layer.expand(rawValue.trim(), env, { setting, layer: name })
        : expandEnvironment(rawValue.trim(), env);
      notes.push(...(expandedValue.notes ?? []));
      const unset = [...expandedKey.unset, ...expandedValue.unset];
      if (unset.length > 0) {
        // An entry that references an unset variable is absent. Sending the placeholder text as a
        // credential would only fail later with a misleading authentication error.
        for (const variable of unset) unsetVariables.add(variable);
        notes.push(
          `Ignored ${setting} in the ${name}: environment variable ${[...new Set(unset)].join(", ")} is not set.`,
        );
        continue;
      }
      const key = expandedKey.text;
      const value = expandedValue.text;
      if (isRegistryKey(key)) {
        if (!value) {
          const message = `Ignored ${setting} in the ${name} because it is empty.`;
          warnings.push(message);
          notes.push(message);
          continue;
        }
        assertRegistryUrl(setting, value, layer);
      } else if (PROXY_URL_KEYS.has(key) && value && !isProxyUrl(value)) {
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
  // npm-registry-fetch picks credentials by host and ignores the protocol; requestOptions removes
  // them for a plain-http request, so say why a request to this registry goes without them.
  if (
    registryUrl.protocol === "http:" &&
    Object.keys(options).some(
      (key) => nerfDartHost(key) === registryUrl.host && !CERTIFICATE_KEY.test(key),
    )
  ) {
    warnings.push(
      `The registry ${registryUrl.origin} uses http, so Calavera sends no credentials to it, although some are configured for ${registryUrl.host}.`,
    );
  }
  return {
    options,
    registry: { origin: registryUrl.origin, source: sources[registryKey]?.name ?? "default" },
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
 * The home folder of the operating system account, which, unlike HOME, the environment cannot
 * redirect. Undefined when the account has no entry, as in some containers.
 */
function accountHomeFolder() {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Invariant 1: the options for one request to `url`, without any credential when it is not an
 * https URL. npm-registry-fetch picks credentials by host and path and ignores the protocol, so a
 * token, basic auth, or client certificate for a host would otherwise go with a plain-http request
 * to it, registry or tarball. Calavera passes every pacote request through this function.
 * @param {Record<string, string>} options
 * @param {string} url
 * @returns {Record<string, string>}
 */
export function requestOptions(options, url) {
  // A local path, which pacote.extract also accepts, needs no credential either.
  if (URL.canParse(url) && new URL(url).protocol === "https:") return options;
  return Object.fromEntries(Object.entries(options).filter(([key]) => !AUTH_KEY.test(key)));
}

/**
 * The URL pacote fetches for a tarball. Unless told otherwise, pacote moves a tarball on
 * registry.npmjs.org onto the configured default registry, which can use http
 * (`replaceRegistryHost` in pacote/lib/fetcher.js and lib/remote.js). requestOptions must judge
 * that URL, not the one the package document names.
 * @param {string} resolved
 * @param {Record<string, string>} options
 */
export function pacoteTarballUrl(resolved, options) {
  if (!URL.canParse(resolved)) return resolved;
  const url = new URL(resolved);
  if (url.host !== "registry.npmjs.org") return resolved;
  const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  return new URL(url.pathname, registry).href;
}

/**
 * The host, with its port, of a nerf-darted key such as //registry.example.com/:_authToken, parsed
 * as a URL so that it compares exactly, or undefined for any other key.
 * @param {string} key
 */
function nerfDartHost(key) {
  const host = /^\/\/([^/]+)\//.exec(key)?.[1];
  return host && URL.canParse(`https://${host}`) ? new URL(`https://${host}`).host : undefined;
}

/** @param {string} value */
function isProxyUrl(value) {
  return URL.canParse(value) && PROXY_PROTOCOLS.has(new URL(value).protocol);
}

/**
 * @param {string} setting The key or setting name, as the person wrote it.
 * @param {string} value
 * @param {ConfigLayer} layer
 */
function assertRegistryUrl(setting, value, layer) {
  const subject = layer.tool
    ? `The ${layer.tool} setting ${setting}`
    : `The npm configuration key ${setting}`;
  const where = layer.name === "environment" ? "" : ` in the ${layer.name}`;
  // The value is never echoed: a registry URL can carry credentials.
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`${subject}${where} must be an http or https URL.`);
  }
  if (!layer.trusted && new URL(value).protocol !== "https:") {
    // A project file must not be able to send the credentials of the user .npmrc without TLS.
    throw new Error(
      `${subject}${where} must be an https URL. To use an http registry, set it in your user configuration.`,
    );
  }
  const { username, password } = new URL(value);
  if (username || password) {
    throw new Error(
      `${subject}${where} must not include a username or password in the URL. Set credentials with //host/:_authToken, //host/:_auth, or //host/:username and //host/:_password in an .npmrc file instead.`,
    );
  }
}
