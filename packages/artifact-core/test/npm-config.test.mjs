import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect, promisify } from "node:util";

import { loadNpmRegistryOptions } from "../src/npm-config.js";

const SCOPE = "@schalkneethling";
const SECRET = "SECRETVALUE0123456789";

/**
 * A project directory and a user .npmrc in a temporary directory, with an environment that cannot
 * reach the developer's own ~/.npmrc.
 * @param {{ project?: string, user?: string, env?: Record<string, string> }} files
 */
async function fixture({ project, user, env = {} }) {
  const directory = await mkdtemp(join(tmpdir(), "calavera-npm-config-"));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  if (project !== undefined) await writeFile(join(cwd, ".npmrc"), project);
  const userconfig = join(directory, "user.npmrc");
  if (user !== undefined) await writeFile(userconfig, user);
  return { directory, cwd, env: { npm_config_userconfig: userconfig, ...env }, scope: SCOPE };
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

test("an http registry with credentials for its host warns about plain text", async () => {
  const withToken = await loadNpmRegistryOptions(
    await fixture({
      user: "registry=http://registry.example.com/\n//registry.example.com/:_authToken=abc\n",
    }),
  );
  assert.equal(withToken.warnings.length, 1);
  assert.match(withToken.warnings[0], /http:\/\/registry\.example\.com/);
  assert.match(withToken.warnings[0], /plain text/);
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
