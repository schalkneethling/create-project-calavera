// ADR-0021 Decision 1: Calavera reads, expands, and sends no registry credential. Every credential
// key is planted for the registry host and for the tarball host, in every file and variable the
// loader reads under each launcher, and resolution and extraction then run against local servers.
// No request may carry an authorization header, no planted value may appear in any output, and
// the loader may return only allowlisted options.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";

import { artifactForId } from "../src/catalog.js";
import { loadNpmRegistryOptions } from "../src/npm-config.js";
import { extractArtifactPackage, resolveArtifactPackage } from "../src/registry.js";
import { removeTemporaryDirectories, temporaryDirectory } from "./temporary-directory.mjs";

afterEach(removeTemporaryDirectories);

const artifact = artifactForId("skill-project-goal");
const packageRoot = fileURLToPath(new URL("../../artifacts/skill-project-goal/", import.meta.url));
const SCOPE = "@schalkneethling";
// Fake values only. Each is distinct, so a leak names the source that leaked.
const PLANTED = {
  token: "fake-token-0123456789abcdef",
  auth: Buffer.from("fake-user:fake-auth-password").toString("base64"),
  username: "fake-username-0123",
  password: Buffer.from("fake-password-0123").toString("base64"),
  scopeToken: "fake-scope-token-0123456789",
  envToken: "fake-env-token-0123456789",
};
const PLANTED_PATTERN = new RegExp(
  [...Object.values(PLANTED), "fake-user", "fake-auth-password", "fake-password-0123"].join("|"),
);
const ALLOWED_OPTIONS = new Set(["registry", `${SCOPE}:registry`, "proxy", "httpsProxy", "noProxy"]);

/**
 * A local server that records the authorization header of every request and answers with
 * `respond`.
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, origin: string) => void} respond
 */
async function startServer(respond) {
  /** @type {{ url: string | undefined, authorization: string | undefined }[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    respond(request, response, `http://127.0.0.1:${port}`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    requests,
    host: `127.0.0.1:${port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done(undefined));
      }),
  };
}

/** @param {string} directory */
async function packFixture(directory) {
  await promisify(execFile)("pnpm", ["pack", "--pack-destination", directory], {
    cwd: packageRoot,
  });
  const name = (await readdir(directory)).find((entry) => entry.endsWith(".tgz"));
  if (!name) throw new Error("Fixture package did not produce a tarball.");
  const tarball = await readFile(join(directory, name));
  return {
    tarball,
    version: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}

/**
 * The .npmrc credential keys for each host. `certfile` and `keyfile` name a folder, so
 * npm-registry-fetch would throw EISDIR if it ever received them: that proves no client
 * certificate is read, so none can be presented.
 * @param {string[]} hosts
 * @param {string} certificateFolder
 */
function npmrcCredentials(hosts, certificateFolder) {
  return hosts
    .flatMap((host) => [
      `//${host}/:_authToken=${PLANTED.token}`,
      `//${host}/:_auth=${PLANTED.auth}`,
      `//${host}/:username=${PLANTED.username}`,
      `//${host}/:_password=${PLANTED.password}`,
      `//${host}/:certfile=${certificateFolder}`,
      `//${host}/:keyfile=${certificateFolder}`,
      `//${host}/:always-auth=true`,
    ])
    .concat([`_authToken=${PLANTED.token}`, `_auth=${PLANTED.auth}`, ""])
    .join("\n");
}

/**
 * The npm_config_* credential variables for each host.
 * @param {string[]} hosts
 * @param {string} certificateFolder
 */
function npmCredentialVariables(hosts, certificateFolder) {
  return Object.fromEntries(
    hosts.flatMap((host) => [
      [`npm_config_//${host}/:_authToken`, PLANTED.envToken],
      [`npm_config_//${host}/:_auth`, PLANTED.auth],
      [`npm_config_//${host}/:username`, PLANTED.username],
      [`npm_config_//${host}/:_password`, PLANTED.password],
      [`npm_config_//${host}/:certfile`, certificateFolder],
      [`npm_config_//${host}/:keyfile`, certificateFolder],
      ["npm_config__auth_token", PLANTED.envToken],
      ["npm_config_force_auth", PLANTED.envToken],
    ]),
  );
}

/**
 * Every credential planted for `hosts` under `launcher`, with the registry of the artifact scope
 * set to `registryUrl` in the user configuration that launcher reads.
 * @param {"npm" | "yarn" | "bun"} launcher
 * @param {string} registryUrl
 * @param {string[]} hosts
 * @param {{ userconfig: boolean }} variant Whether npm_config_userconfig names the user file.
 */
async function plantedFixture(launcher, registryUrl, hosts, { userconfig }) {
  const directory = await temporaryDirectory(`calavera-no-credentials-${launcher}-`);
  const home = join(directory, "home");
  const cwd = join(directory, "project");
  const certificateFolder = join(directory, "certificates");
  for (const folder of [home, cwd, certificateFolder]) await mkdir(folder, { recursive: true });
  const credentials = npmrcCredentials(hosts, certificateFolder);
  const scopeLine = `${SCOPE}:registry=${registryUrl}\n`;
  const userconfigPath = join(directory, "chosen.npmrc");

  // The .npmrc files: the user file, the file npm_config_userconfig names, and the project file.
  const userNpmrc = launcher === "npm" && !userconfig ? scopeLine + credentials : credentials;
  await writeFile(join(home, ".npmrc"), userNpmrc);
  await writeFile(
    userconfigPath,
    launcher === "npm" && userconfig ? scopeLine + credentials : credentials,
  );
  await writeFile(join(cwd, ".npmrc"), credentials);

  const yarnCredentials = (/** @type {string} */ token) =>
    [
      `npmAuthToken: ${token}`,
      `npmAuthIdent: ${PLANTED.username}:${PLANTED.password}`,
      "npmAlwaysAuth: true",
      "npmRegistries:",
      ...hosts.flatMap((host) => [`  "//${host}":`, `    npmAuthToken: ${token}`]),
      "",
    ].join("\n");
  await writeFile(
    join(home, ".yarnrc.yml"),
    (launcher === "yarn"
      ? `npmScopes:\n  schalkneethling:\n    npmRegistryServer: "${registryUrl}"\n    npmAuthToken: ${PLANTED.scopeToken}\n`
      : "") + yarnCredentials(PLANTED.token),
  );
  await writeFile(join(cwd, ".yarnrc.yml"), yarnCredentials(PLANTED.token));

  const bunTable = `token = "${PLANTED.token}", username = "${PLANTED.username}", password = "${PLANTED.password}"`;
  await writeFile(
    join(home, ".bunfig.toml"),
    `[install]\ntoken = "${PLANTED.token}"\n[install.scopes]\n${
      launcher === "bun"
        ? `schalkneethling = { url = "${registryUrl}", ${bunTable} }`
        : `other = { url = "https://other.example.com/", ${bunTable} }`
    }\n`,
  );
  await writeFile(
    join(cwd, "bunfig.toml"),
    `[install]\ntoken = "${PLANTED.token}"\n[install.scopes]\nschalkneethling = { token = "${PLANTED.scopeToken}" }\n`,
  );

  const userAgent = {
    npm: "npm/11.6.0 node/v24.3.0 darwin arm64 workspaces/false",
    yarn: "yarn/4.9.1 npm/? node/v24.3.0 darwin arm64",
    bun: "bun/1.3.9 npm/? node/v24.3.0 darwin arm64",
  }[launcher];
  return {
    directory,
    cwd,
    cache: join(directory, "cache"),
    env: {
      HOME: home,
      npm_config_user_agent: userAgent,
      ...(userconfig ? { npm_config_userconfig: userconfigPath } : {}),
      ...npmCredentialVariables(hosts, certificateFolder),
      YARN_NPM_AUTH_TOKEN: PLANTED.envToken,
      YARN_NPM_AUTH_IDENT: `${PLANTED.username}:${PLANTED.password}`,
      NPM_TOKEN: PLANTED.envToken,
    },
  };
}

/** @type {["npm" | "yarn" | "bun", { userconfig: boolean }][]} */
const RUNS = [
  ["npm", { userconfig: false }],
  ["npm", { userconfig: true }],
  ["yarn", { userconfig: false }],
  ["bun", { userconfig: false }],
  ["bun", { userconfig: true }],
];

for (const [launcher, variant] of RUNS) {
  const label = `${launcher}${variant.userconfig ? " with npm_config_userconfig" : ""}`;

  test(`under ${label}, no planted credential reaches a request, an option, or any output`, async (t) => {
    const directory = await temporaryDirectory("calavera-no-credentials-pack-");
    const packed = await packFixture(directory);
    const tarballHost = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(packed.tarball);
    });
    const registry = await startServer((_request, response, origin) => {
      void origin;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: artifact.packageName,
          "dist-tags": { latest: packed.version },
          versions: {
            [packed.version]: {
              name: artifact.packageName,
              version: packed.version,
              dist: {
                tarball: `http://${tarballHost.host}/-/artifact.tgz`,
                integrity: packed.integrity,
              },
            },
          },
        }),
      );
    });
    t.after(async () => {
      await registry.close();
      await tarballHost.close();
    });
    const fixture = await plantedFixture(
      launcher,
      `http://${registry.host}/`,
      [registry.host, tarballHost.host],
      variant,
    );
    const npm = { cwd: fixture.cwd, env: fixture.env };

    const loaded = await loadNpmRegistryOptions({ ...npm, scope: SCOPE });
    const unexpected = Object.keys(loaded.options).filter((key) => !ALLOWED_OPTIONS.has(key));
    // Only the names of unexpected options are reported, never their values.
    assert.deepEqual(unexpected, []);
    assert.equal(loaded.options[`${SCOPE}:registry`], `http://${registry.host}/`);

    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      ...npm,
    });
    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      npm,
    );
    assert.equal(result.manifest.id, "skill-project-goal");
    assert.equal(registry.requests.length, 1);
    assert.equal(tarballHost.requests.length, 1);
    for (const request of [...registry.requests, ...tarballHost.requests]) {
      assert.equal(request.authorization, undefined, request.url);
    }
    // Calavera does not look for credential keys, so no warning names one (owner decision 4).
    assert.deepEqual([loaded.warnings, loaded.diagnostics], [[], []]);
    assert.doesNotMatch(inspect([loaded, resolution], { depth: 10 }), PLANTED_PATTERN);
  });

  test(`under ${label}, a 401 from the registry carries no planted credential in its message or causes`, async (t) => {
    const registry = await startServer((_request, response) => {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Basic realm="fake"',
      });
      response.end(JSON.stringify({ error: "authentication required" }));
    });
    t.after(() => registry.close());
    const fixture = await plantedFixture(
      launcher,
      `http://${registry.host}/`,
      [registry.host],
      variant,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the registry failure to reject."),
      (error) => error,
    );
    assert.match(failure.message, /Calavera sends no credentials to any registry/);
    assert.equal(registry.requests[0]?.authorization, undefined);
    assert.doesNotMatch(inspect(failure, { depth: 10 }), PLANTED_PATTERN);
  });
}
