import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";

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
  assert.deepEqual(none.registry, { host: "registry.npmjs.org", source: "default" });

  const user = await loadNpmRegistryOptions(
    await fixture({ user: "registry=https://user.example.com:8443/\n" }),
  );
  assert.deepEqual(user.registry, { host: "user.example.com:8443", source: "user .npmrc" });

  const project = await loadNpmRegistryOptions(
    await fixture({
      user: "registry=https://user.example.com/\n",
      project: `${SCOPE}:registry=https://project.example.com/\n`,
    }),
  );
  assert.deepEqual(project.registry, { host: "project.example.com", source: "project .npmrc" });

  const env = await loadNpmRegistryOptions(
    await fixture({
      project: "registry=https://project.example.com/\n",
      env: { NPM_CONFIG_REGISTRY: "https://env.example.com/" },
    }),
  );
  assert.deepEqual(env.registry, { host: "env.example.com", source: "environment" });
});
