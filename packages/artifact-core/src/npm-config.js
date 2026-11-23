// @ts-check
import { access, realpath } from "node:fs/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { decode } from "ini";

import { printable, readConfigText } from "./config-files.js";
import {
  bunEnvironmentFileChains,
  environmentFileValues,
  hasBunReference,
  hasYarnReference,
  variablesFromReferences,
} from "./environment-files.js";
import {
  YARN_DEFAULT_REGISTRY,
  bunEnvironmentLayer,
  bunfigLayers,
  detectLauncher,
  isAccountFile,
  yarnEnvironmentFiles,
  yarnLayers,
} from "./launcher-config.js";

/** @typedef {import("./launcher-config.js").Launcher} Launcher */

// pacote and npm-registry-fetch do not read .npmrc files. The npm CLI loads them with
// @npmcli/config and passes the result as options. This loader reproduces only the part that
// decides where a request goes and through which proxy, with npm's precedence for those keys: the
// global npmrc (only when npm started Calavera), then the user .npmrc, then the project .npmrc,
// then npm_config_* environment variables. The built-in npmrc, command-line flags, and other
// settings (CA) are not read. The project .npmrc is the one in `cwd`, or, when npm started Calavera, the one at npm's
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
// The npm settings that choose the global config file (`globalconfig`, and `prefix`, whose
// etc/npmrc is the default).
const GLOBAL_CONFIG_CHOOSERS = new Set(["globalconfig", "prefix"]);
const GLOBAL_LAYER = "global npmrc";
// The variables from which Calavera recognizes the package manager that started it.
const LAUNCHER_VARIABLES = ["npm_execpath", "npm_config_user_agent"];
// The folder Calavera started in, before the CLI changes into a new or ancestor project. Yarn and
// Bun loaded their environment files relative to it (#1186).
const STARTING_CWD = process.cwd();
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
  /** @type {Record<string, string>} */
  const variables = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^npm_config_/i.test(name) || !value) continue;
    const key = name
      .slice("npm_config_".length)
      .replace(/(?!^)_/g, "-")
      .toLowerCase();
    // npm exports a list setting joined with blank lines (`envVal` in @npmcli/config
    // set-envs.js), but @npmcli/agent splits noProxy on commas only.
    settings[key] = key === "noproxy" ? value.split("\n\n").join(",") : value;
    variables[key] = name;
  }
  return { settings, variables };
}

/**
 * The key of `entries` whose value a package manager exported as the variable for `key`, if any.
 * A variable name keeps only letters, digits, and underscores, so other spellings of a key, such
 * as https_proxy or HTTPS-PROXY, export under the same name.
 *
 * npm expands keys and values with the environment it had when it loaded the file, before it
 * exports its settings and INIT_CWD, so a value such as
 * `http://evil.example/${npm_config_https_proxy?}` or a key such as `https-proxy${INIT_CWD?}`
 * expands differently here. In a file that Calavera does not expand, each variable in a key
 * therefore may stand for any text (keyMatches), and the file holds the exported value whenever
 * its entry for the key contains a variable (#1186). npm exports a list as its entries joined with
 * blank lines (`envVal` in @npmcli/config set-envs.js), and leaves the entries of a list under a
 * key that is not a list setting, such as `https-proxy[]`, as written.
 * @param {Record<string, unknown>} entries
 * @param {string} key
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} expands Whether Calavera expands variables in this file.
 */
function exportedFrom(entries, key, value, env, expands) {
  return Object.keys(entries).find((fileKey) => {
    if (!keyMatches(fileKey, key, env, expands)) return false;
    const fileValue = entries[fileKey];
    // A list is compared as npm joins it, with blank lines. The environment layer joins a noproxy
    // list with commas, so a noproxy list of more than one entry matches no file and applies as
    // environment, which does not matter: a project file may set noproxy.
    if (Array.isArray(fileValue)) return fileValue.map(String).join("\n\n") === value;
    if (typeof fileValue !== "string") return false;
    if (!expands && fileValue.includes("${")) return true;
    return expandEnvironment(fileValue.trim(), env).text === value.trim();
  });
}

/**
 * Whether npm reads the .npmrc key `fileKey` as the setting `key`. npm expands ${VAR} in keys
 * (`envReplace(key, this.env)` in @npmcli/config lib/index.js), so `https-proxy${UNSET?}` is
 * https-proxy, and exports another spelling, such as https_proxy, under the same variable. In a
 * file that Calavera does not expand, npm's expansion cannot be reproduced, because npm ran it
 * before setting INIT_CWD and its npm_config_* exports, so each variable may stand for any text.
 * @param {string} fileKey
 * @param {string} key
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} expands Whether Calavera expands variables in this file.
 */
function keyMatches(fileKey, key, env, expands) {
  if (expands || !fileKey.includes("${")) {
    return normalizedKey(expandEnvironment(fileKey, env).text) === key;
  }
  const pattern = fileKey
    .split(/\$\{[^}]*\}/)
    // normalizedKey leaves only letters, digits, and hyphens, which need no escaping.
    .map((piece) => normalizedKey(piece))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(key);
}

/**
 * A userconfig path as npm resolves it: `~/` from the home folder, anything else from the working
 * folder (`parseField` in @npmcli/config).
 * @param {string} value @param {string} home @param {string} cwd
 */
function resolveUserconfig(value, home, cwd) {
  const homePattern = process.platform === "win32" ? /^~(\/|\\)/ : /^~\//;
  return homePattern.test(value) ? resolve(home, value.slice(2)) : resolve(cwd, value);
}

/**
 * The user .npmrc. Bun also reads `$XDG_CONFIG_HOME/.npmrc` when it exists and no userconfig is
 * set (https://bun.com/docs/install/npmrc).
 * @param {NodeJS.ProcessEnv} env @param {string} home @param {Launcher} launcher
 */
async function userConfigPath(env, home, launcher) {
  const configured = environmentSettings(env).settings.userconfig;
  if (typeof configured === "string") {
    return resolveUserconfig(expandEnvironment(configured, env).text, home, process.cwd());
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
 * proxy values of the environment and of the user's own ~/.npmrc or ~/.yarnrc.yml only, in the
 * operating system account's home folder (#1186). A project file is repository content and must
 * not read the caller's environment, so a proxy value of it that contains `${` is ignored, and so
 * is a proxy it sets. A user file that HOME or npm_config_userconfig names elsewhere can be chosen
 * by a project file, such as a project .npmrc `userconfig` or a Yarn 4 `.env.yarn`, so a proxy
 * value of it that contains `${` is ignored too.
 * `warnings` are for the user. `diagnostics` hold every ignored entry and unset variable, for
 * failure messages. `unsetVariables` lists variable names. None of them ever contains a value.
 * `registryUrl` is the URL of the registry that serves `scope`, without user information.
 *
 * A Yarn 4 `.env.yarn`, and the `.env` files Bun loads when Bun runs Calavera, put their values
 * into the environment with variables already expanded. A registry or proxy variable whose value
 * came from a variable in such a file is ignored with a warning (#1186, owner decisions 2 and 3
 * of 2026-11-24); one that the file sets literally follows the environment rules. When that
 * variable is a proxy variable that @npmcli/agent falls back to, such as HTTPS_PROXY,
 * and no proxy setting applies, `requestOptions` sends every request, redirects included, through
 * an agent without a proxy; otherwise it equals `options`.
 * `accountHome` replaces the operating system account's home folder, and `runtime` the runtime
 * that runs Calavera, for tests only.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, scope?: string, accountHome?: string, runtime?: "bun" | "node" }} [context]
 * @returns {Promise<{ options: Record<string, string>, requestOptions: Record<string, unknown>, registry: EffectiveRegistry, registryUrl: string, warnings: string[], diagnostics: string[], unsetVariables: string[] }>}
 */
export async function loadNpmRegistryOptions({
  cwd: cwdOption,
  env = process.env,
  scope,
  accountHome = accountHomeFolder(),
  runtime = process.versions.bun ? "bun" : "node",
} = {}) {
  const cwd = cwdOption ?? process.cwd();
  // The folder whose environment files Yarn or Bun loaded: the given `cwd`, or else the folder
  // Calavera started in. Yarn also passes its own starting folder as INIT_CWD.
  const startingCwd = cwdOption ?? STARTING_CWD;
  /** @type {string[]} */
  const warnings = [];
  // Notes for failure messages only; `diagnostics` adds every warning to them.
  /** @type {string[]} */
  const notes = [];
  /** @type {Set<string>} */
  const unsetVariables = new Set();
  const home = env.HOME || homedir();
  // Under a direct Bun run (`bun file.js`), Bun sets neither npm_execpath nor
  // npm_config_user_agent, so a project .env that Bun loaded could set both and switch Calavera to
  // another package manager's settings. A launcher variable that equals the value a loaded .env
  // file gives it, or that the file sets from a variable, is repository content and is not read;
  // Calavera then reads the Bun settings, as Bun runs it. `bun run` sets both itself after it
  // loads .env, so their values are Bun's own (#1186).
  const bunChains =
    runtime === "bun" ? await bunEnvironmentFileChains(startingCwd, env, warnings) : [];
  /** @type {Set<string>} */
  const launcherFromFile = new Set();
  for (const chain of bunChains) {
    const values = await environmentFileValues(chain);
    for (const name of LAUNCHER_VARIABLES) {
      const value = values.get(name);
      if (value !== undefined && (value === env[name] || hasBunReference(value))) {
        launcherFromFile.add(name);
      }
    }
  }
  const launcher = launcherFromFile.size > 0 ? "bun" : detectLauncher(env);
  if (launcherFromFile.size > 0) {
    warnings.push(
      `Ignored ${[...launcherFromFile].join(" and ")}, which .env sets: Calavera reads the package manager that started it only from variables the package manager sets, so it reads the Bun settings, as Bun runs it.`,
    );
  }
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
  /** @type {ConfigLayer | undefined} */
  let globalLayer;
  const launcherContext = { cwd, env, home, accountHome, scope, warnings };
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
    const userIsAccountFile = isAccountFile(userPath, accountHome, ".npmrc");
    // Owner decision 1 on #1186 (2026-11-24): a user file that the project .npmrc chose with
    // `userconfig` follows the project rules, unless it is your own ~/.npmrc. npm resolves the
    // project's value as it resolves npm_config_userconfig, and lets a caller's
    // npm_config_userconfig win, so the file is the project's only when the two agree. npm
    // honors only the exact key, but exports every spelling of it in lowercase, so a project
    // `USERCONFIG=./evil.npmrc` replaces the caller's npm_config_userconfig although npm read the
    // caller's file; Calavera cannot find that file, so the one it reads follows the project
    // rules too, as does one whose path holds a variable that Calavera cannot reproduce.
    const projectUserconfig = projectEntries.userconfig;
    const userconfigRespelled = Object.keys(projectEntries).some(
      (key) => key !== "userconfig" && keyMatches(key, "userconfig", env, false),
    );
    const userChosenByProject =
      npmStarted &&
      !userIsAccountFile &&
      (userconfigRespelled ||
        (typeof projectUserconfig === "string" &&
          (projectUserconfig.includes("${") ||
            // npm resolves a relative path from the folder it started in, which it exports as
            // INIT_CWD; `npm run` then runs the script in the local prefix.
            (await realPath(resolveUserconfig(projectUserconfig, home, env.INIT_CWD || cwd))) ===
              (await realPath(userPath)))));
    const globalPath = npmStarted ? globalConfigPath(env, dirname(projectPath)) : undefined;
    if (globalPath !== undefined && globalPath !== userPath && globalPath !== projectPath) {
      // npm reads a global config file below the user .npmrc, expands variables in it, and
      // exports its values (#1186). A project file can choose it with `globalconfig` or with
      // `prefix` (npm logs an error for a project prefix but still applies it), and so can a
      // user file that the project .npmrc chose with `userconfig`, unless that user file is
      // your own ~/.npmrc. Such a global file, or one inside the project, is repository content
      // and follows the project rules. Otherwise it is the global file of the npm installation
      // and keeps user trust, without variable expansion.
      /** @param {Record<string, unknown>} entries @param {Set<string>} names */
      const setsOneOf = (entries, names) =>
        Object.keys(entries).some((key) =>
          [...names].some((name) => keyMatches(key, name, env, false)),
        );
      const userEntriesChoose =
        !userIsAccountFile && setsOneOf(projectEntries, new Set(["userconfig"]));
      const chosen = [projectEntries, ...(userEntriesChoose ? [userEntries] : [])].some((entries) =>
        setsOneOf(entries, GLOBAL_CONFIG_CHOOSERS),
      );
      // Real paths, so a symbolic link to the project, or /var and /private/var on macOS, cannot
      // place a project file outside it.
      const fromProject = relative(
        await realPath(dirname(projectPath)),
        await realPath(globalPath),
      );
      const inProject = !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject);
      globalLayer = {
        name: GLOBAL_LAYER,
        entries: await readNpmrc(globalPath, warnings),
        trusted: !chosen && !inProject,
        expandsVariables: false,
        accepts,
      };
    }
    /** @type {ConfigLayer[]} */
    const npmFiles = [
      ...(globalLayer ? [globalLayer] : []),
      {
        name: userChosenByProject ? "user .npmrc that the project .npmrc chose" : "user .npmrc",
        entries: userEntries,
        trusted: !userChosenByProject,
        // userChosenByProject is never true for your own ~/.npmrc.
        expandsVariables: userIsAccountFile,
        accepts,
      },
      { name: "project .npmrc", entries: projectEntries, trusted: false, accepts },
    ];
    const { settings: environmentEntries, variables } = environmentSettings(env);
    /** @type {ConfigLayer} */
    const npmEnvironment = {
      name: "environment",
      entries: environmentEntries,
      variables,
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
  /**
   * Applies one entry of `layer` under that layer's rules.
   * @param {ConfigLayer} layer @param {string} key @param {string} setting @param {string} rawValue
   */
  const applyEntry = (layer, key, setting, rawValue) => {
    const { name, trusted } = layer;
    if (isRegistryKey(key)) {
      const value = registryValue(setting, rawValue.trim(), layer, warnings);
      if (value === undefined) return;
      options[key] = value;
      sources[key] = layer;
      return;
    }
    if (rawValue.includes("${") && !(layer.expandsVariables ?? trusted)) {
      warnings.push(
        trusted && name === GLOBAL_LAYER
          ? `Ignored ${setting} in the ${name}: Calavera expands variables only in your own .npmrc in your account's home folder and in environment variables, not in npm's global configuration file. Write the proxy URL without a variable, or remove the entry and set the proxy in your own .npmrc or an environment variable; while the entry is there, an npm_config_${key.replace(/-/g, "_")} variable does not replace it when npm starts Calavera.`
          : trusted
            ? `Ignored ${setting} in the ${name}: Calavera expands variables only in your own ${layer.tool === "Yarn" ? ".yarnrc.yml" : ".npmrc"} in your account's home folder and in environment variables, never in a file that a variable or a project file names.${layer.tool === "Yarn" ? "" : ` Write the proxy URL without a variable, or remove the entry and set the proxy in your own .npmrc or an environment variable; while the entry is there, an npm_config_${key.replace(/-/g, "_")} variable does not replace it when npm starts Calavera.`}`
            : `Ignored ${setting} in the ${name}: Calavera expands variables only in user configuration files and environment variables, never in a project file.`,
      );
      return;
    }
    if (!trusted) {
      // A project file could name a proxy it controls, which would see which packages Calavera
      // fetches and, for an http registry, could replace the package documents and tarballs
      // together. The entry is skipped here, so it never replaces a proxy from a user file. An
      // empty value and a noproxy entry only remove the proxy, so a project file may still set
      // them. The warning is written after every layer is read, so it names the proxy that
      // applies.
      if (PROXY_URL_KEYS.has(key) && rawValue.trim()) {
        rejectedProxies.push({ key, setting, layer: name });
        return;
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
      return;
    }
    const value = expanded.text;
    if (PROXY_URL_KEYS.has(key) && value && !isProxyUrl(value)) {
      // The value is never echoed: a proxy URL can carry credentials.
      warnings.push(
        `Ignored ${setting} in the ${name}: it must be an http, https, or socks proxy URL.`,
      );
      return;
    }
    options[key] = value;
    sources[key] = layer;
  };

  /**
   * Whether npm exported the value of `key` from `layer`'s file, where the file holds it under
   * `fileKey`. The layer applied a value under the same key itself. A key that npm expands to
   * `key`, such as `registry${UNSET?}`, is one npm uses but the layer did not read, so it is
   * applied here under the layer's rules: a variable in a registry value stops the command, and
   * a project file must use https. Another spelling, such as https_proxy, and a list that is
   * not noproxy, the layer did not apply; a proxy under it from a project file is reported as
   * ignored.
   *
   * A file entry with a variable claims the exported value whatever it is, because npm's
   * expansion cannot be reproduced. npm passes a value that the caller set for the same variable
   * on unchanged, so that value is dropped with it, and a note says so, never with the value.
   * @param {ConfigLayer} layer @param {string} key @param {string} fileKey
   * @param {string} rawValue The exported value. @param {string | undefined} variable Its name.
   */
  const applyExportedCopy = (layer, key, fileKey, rawValue, variable) => {
    const fileValue = entryValue(key, layer.entries[fileKey]);
    if (
      fileValue?.includes("${") &&
      !(layer.expandsVariables ?? layer.trusted) &&
      fileValue.trim() !== rawValue.trim()
    ) {
      const name = printable(variable ?? key);
      const setting = printable(fileKey);
      warnings.push(
        `Also ignored ${name} in the environment: the ${layer.name} sets ${setting} with a variable, and npm passes on its own expansion under the same variable, so Calavera cannot tell a value you set from the one in that file. If you set ${name} yourself, remove ${setting} from the ${layer.name}.`,
      );
    }
    if (fileValue !== undefined && fileKey === key) return;
    // A key with a variable that this layer does not expand matched as a pattern, so npm may
    // read it as `key`.
    const patternKey = !(layer.expandsVariables ?? layer.trusted) && fileKey.includes("${");
    if (fileValue !== undefined && (patternKey || expandEnvironment(fileKey, env).text === key)) {
      applyEntry(layer, key, printable(fileKey), fileValue);
      return;
    }
    if (!layer.trusted && PROXY_URL_KEYS.has(key)) {
      rejectedProxies.push({ key, setting: printable(fileKey), layer: layer.name });
    }
  };

  // The variables that a Yarn 4 `.env.yarn` or a Bun `.env` file set from a variable (#1186).
  /** @type {Map<string, { path: string, tool: string }>} */
  const fromEnvironmentFiles = new Map();
  /** @param {Map<string, string>} claimed @param {string} tool */
  const addClaims = (claimed, tool) => {
    for (const [name, path] of claimed) fromEnvironmentFiles.set(name, { path, tool });
  };
  // Set when a Yarn environment file path holds a variable, so Calavera cannot tell which file
  // Yarn loaded; every registry and proxy variable is then ignored.
  let unresolvedEnvironmentFiles = false;
  if (launcher === "yarn") {
    // Yarn's starting folder is INIT_CWD for its scripts and binaries, but not under `yarn dlx`,
    // and Calavera may have moved since it started, so every candidate counts.
    const folders = [...new Set([env.INIT_CWD, startingCwd, cwd].filter((folder) => !!folder))];
    const files = await yarnEnvironmentFiles({
      folders: /** @type {string[]} */ (folders),
      home,
      env,
    });
    unresolvedEnvironmentFiles = files.unresolved;
    // Each file counts on its own: a variable that any of them sets from a variable is ignored,
    // because Calavera cannot tell which of them Yarn loaded, or in which order.
    for (const path of files.paths) {
      addClaims(await variablesFromReferences([path], hasYarnReference, warnings), "Yarn");
    }
  }
  if (runtime === "bun") {
    for (const chain of bunChains) {
      addClaims(await variablesFromReferences(chain, hasBunReference, warnings), "Bun");
    }
  }
  /** @param {string} name */
  const ignoreFromEnvironmentFile = (name) => {
    if (unresolvedEnvironmentFiles) {
      warnings.push(
        `Ignored ${printable(name)}: a .yarnrc.yml setting or YARN_INJECT_ENVIRONMENT_FILES names an environment file with a variable in its path, so Calavera cannot tell which file Yarn loaded or whether it set this variable from a variable. Write the path without a variable.`,
      );
      return true;
    }
    const claim = fromEnvironmentFiles.get(name);
    if (!claim) return false;
    const file = printable(relative(cwd, claim.path) || claim.path);
    const variable = printable(name);
    warnings.push(
      `Ignored ${variable}, which ${file} sets from a variable: ${claim.tool} expanded the variable before Calavera started, and Calavera does not take a variable's value from a project file. Write the value without a variable in ${file}, or remove it from ${file} and set ${variable} in your own environment.`,
    );
    return true;
  };

  // The .npmrc layers whose values npm exports, the project file first, because its rules are
  // the strictest when two files hold the same value.
  const fileLayers = layers.filter((candidate) => !candidate.npmEnvironment);
  const exportingLayers = [
    ...fileLayers.filter((candidate) => !candidate.trusted),
    ...fileLayers.filter((candidate) => candidate.trusted),
  ];
  for (const layer of layers) {
    for (const [key, entry] of Object.entries(layer.entries)) {
      // The allowlist comes first, so the value of any other key, such as a credential, is never
      // looked at. Launcher layers hold only the keys Calavera reads.
      if (layer.accepts && !layer.accepts(key)) continue;
      const rawValue = entryValue(key, entry);
      if (rawValue === undefined) continue;
      const variable = layer.variables?.[key];
      if (variable !== undefined && ignoreFromEnvironmentFile(variable)) continue;
      if (layer.npmEnvironment && npmStarted) {
        // npm exports its resolved settings, and for a .npmrc value it exports the result of its
        // own ${VAR} expansion. Such a value is the file's content, not environment, so it
        // follows the file's rules and keeps its label. npm exports a key written in another
        // spelling, such as https_proxy, under the same variable, so the comparison normalizes
        // the file's keys as the variable names are normalized. The file's value is expanded
        // only for this comparison, never used. The user layer and the global layer applied, or
        // ignored, a value equal to their own (#1186). A value that matches no file came from
        // somewhere Calavera does not read, such as the caller's environment or an npm
        // command-line flag, so it is trusted as environment. An npm that another npm started
        // passes the outer project's exports on as environment too; running such a command
        // already runs the outer repository's scripts.
        const match = exportingLayers
          .map((fileLayer) => ({
            fileLayer,
            fileKey: exportedFrom(
              fileLayer.entries,
              key,
              rawValue,
              env,
              fileLayer.expandsVariables ?? fileLayer.trusted,
            ),
          }))
          .find(({ fileKey }) => fileKey !== undefined);
        if (match?.fileKey !== undefined) {
          applyExportedCopy(match.fileLayer, key, match.fileKey, rawValue, variable);
          continue;
        }
      }
      applyEntry(layer, key, printable(layer.settingNames?.[key] ?? key), rawValue);
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
  // A proxy variable that an environment file set from a variable is not used: requestOptions
  // excludes each request's host from proxies, which is the only way to stop @npmcli/agent from
  // falling back to it.
  const ignoredProxyVariables = Object.keys(env).filter(
    (name) =>
      ["https_proxy", "http_proxy", "proxy"].includes(name.toLowerCase()) &&
      env[name] &&
      ignoreFromEnvironmentFile(name),
  );
  const environmentProxy =
    ignoredProxyVariables.length > 0
      ? undefined
      : (registryUrl.protocol === "https:"
          ? ["https_proxy"]
          : ["https_proxy", "http_proxy", "proxy"]
        )
          .map((wanted) =>
            Object.keys(env).find((name) => name.toLowerCase() === wanted && env[name]),
          )
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
  const bypassEnvironmentProxy =
    ignoredProxyVariables.length > 0 && !options.proxy && !options.httpsProxy;
  return {
    options,
    // @npmcli/agent uses an `agent` option as it is, for the first request and for every
    // redirect (`getAgent` in @npmcli/agent and `remoteFetch` in make-fetch-happen), and
    // minipass-fetch calls a function agent with the request URL. Direct agents therefore keep
    // the ignored proxy variable away from every host a request reaches.
    requestOptions: bypassEnvironmentProxy ? { ...options, agent: directAgent } : options,
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

const directAgents = {
  http: new HttpAgent({ keepAlive: true }),
  https: new HttpsAgent({ keepAlive: true }),
};

/**
 * An agent without a proxy for the protocol of `url`.
 * @param {URL} url
 */
function directAgent(url) {
  return url.protocol === "https:" ? directAgents.https : directAgents.http;
}

/**
 * The real path of `path`, or `path` itself when it does not exist.
 * @param {string} path
 */
async function realPath(path) {
  return realpath(path).catch(() => path);
}

/**
 * The text of an entry, or undefined when it is not text. npm accepts noproxy as a list
 * (noproxy[]=host) and joins it with commas.
 * @param {string} key
 * @param {unknown} entry
 */
function entryValue(key, entry) {
  const value = key === "noproxy" && Array.isArray(entry) ? entry.join(",") : entry;
  return typeof value === "string" ? value : undefined;
}

/**
 * The global config file npm read: the file npm_config_globalconfig names, which npm exports
 * whether a setting chose it or it is the default `<prefix>/etc/npmrc`, and otherwise
 * `etc/npmrc` in npm_config_global_prefix (the `globalconfig` default in @npmcli/config
 * lib/index.js, and `setEnvs`). npm exports both as absolute paths; a relative one, which only a
 * hand-made environment holds, is resolved from `localPrefix`.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} localPrefix
 */
function globalConfigPath(env, localPrefix) {
  if (env.npm_config_globalconfig) return resolve(localPrefix, env.npm_config_globalconfig);
  if (env.npm_config_global_prefix) {
    return resolve(localPrefix, env.npm_config_global_prefix, "etc", "npmrc");
  }
  return undefined;
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
  return new URL(url.pathname, registry).href;
}

/**
 * The operating system account's home folder, which HOME does not change, or undefined when the
 * account has none (`userInfo` throws for a user without a password database entry).
 */
function accountHomeFolder() {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
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
      `${subject}${where} must be an https URL. A project file wins over your own configuration, so to use an http registry, remove this setting there and set the registry in your own ${layer.tool === "Yarn" ? "~/.yarnrc.yml" : "~/.npmrc"} or in an environment variable.`,
    );
  }
  if (!url.username && !url.password) return value;
  url.username = "";
  url.password = "";
  warnings.push(
    `Used ${setting} from the ${layer.name} without the username and password in its URL: Calavera sends no credentials to any registry.`,
  );
  return url.href;
}
