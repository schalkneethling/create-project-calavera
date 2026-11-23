import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";

import pacote from "pacote";

import { artifactForId } from "../src/catalog.js";
import {
  extractArtifactPackage,
  hashArtifactPayload,
  resolveArtifactPackage,
} from "../src/registry.js";

const projectGoalPackageRoot = fileURLToPath(
  new URL("../../artifacts/skill-project-goal/", import.meta.url),
);
const releasePackageRoot = fileURLToPath(
  new URL("../../artifacts/skill-release-with-confidence/", import.meta.url),
);
const artifact = artifactForId("skill-project-goal");
const execFileAsync = promisify(execFile);

/**
 * An npm context that cannot reach the developer's own user .npmrc or npm_config_* variables.
 * @param {string} directory
 */
function isolatedNpm(directory) {
  return { cwd: directory, env: { npm_config_userconfig: join(directory, "missing.npmrc") } };
}

async function packFixture(directory, packageRoot = projectGoalPackageRoot) {
  await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: packageRoot });
  const name = (await readdir(directory)).find((entry) => entry.endsWith(".tgz"));
  if (!name) throw new Error("Fixture package did not produce a tarball.");
  const path = join(directory, name);
  const tarball = await readFile(path);
  return {
    path,
    tarball,
    version: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}

/**
 * The tarball URL of `packed` on a loopback registry that closes when test `t` ends. Calavera
 * fetches a tarball only from an https URL or a loopback http one, never from a local path (#1194).
 * @param {{ tarball: Buffer, version: string, integrity: string }} packed
 * @param {import("node:test").TestContext} t
 */
async function servedTarballUrl(packed, t) {
  const registry = await startRegistry(packed);
  t.after(registry.close);
  return `http://${registry.host}/-/artifact.tgz`;
}

test("verified extraction checks package identity, manifest compatibility, and payload hash", async (t) => {
  const destination = await mkdtemp(join(tmpdir(), "calavera-registry-extract-"));
  const packed = await packFixture(destination);
  const resolved = await servedTarballUrl(packed, t);
  const result = await extractArtifactPackage(
    {
      artifact,
      packageName: artifact.packageName,
      version: packed.version,
      resolved,
      integrity: packed.integrity,
      tag: "latest",
      cache: join(destination, "cache"),
      offline: false,
    },
    join(destination, "package"),
    "2.2.0",
    isolatedNpm(destination),
  );
  assert.equal(result.manifest.id, "skill-project-goal");
  assert.match(result.payloadHash, /^[a-f0-9]{64}$/);

  await assert.rejects(
    () =>
      extractArtifactPackage(
        {
          artifact,
          packageName: artifact.packageName,
          version: packed.version,
          resolved,
          integrity: packed.integrity,
          tag: "latest",
          cache: join(destination, "cache"),
          offline: false,
        },
        join(destination, "incompatible"),
        "2.1.0",
        isolatedNpm(destination),
      ),
    /not compatible/,
  );
});

test("verified extraction rejects a tarball that fails npm integrity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-integrity-"));
  const packed = await packFixture(directory);
  const resolved = await servedTarballUrl(packed, t);

  await assert.rejects(
    () =>
      extractArtifactPackage(
        {
          artifact,
          packageName: artifact.packageName,
          version: packed.version,
          resolved,
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          tag: "latest",
          cache: join(directory, "cache"),
          offline: false,
        },
        join(directory, "package"),
        "2.2.0",
        isolatedNpm(directory),
      ),
    /integrity|checksum/i,
  );
});

test("prerelease CLIs accept compatible stable-line and prerelease artifacts", async (t) => {
  for (const [id, packageRoot] of [
    ["skill-project-goal", projectGoalPackageRoot],
    ["skill-release-with-confidence", releasePackageRoot],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `calavera-registry-${id}-`));
    const packed = await packFixture(directory, packageRoot);
    const selectedArtifact = artifactForId(id);
    const resolved = await servedTarballUrl(packed, t);
    const result = await extractArtifactPackage(
      {
        artifact: selectedArtifact,
        packageName: selectedArtifact.packageName,
        version: packed.version,
        resolved,
        integrity: packed.integrity,
        tag: "next",
        cache: join(directory, "cache"),
        offline: false,
      },
      join(directory, "package"),
      "2.4.0-next.0",
      isolatedNpm(directory),
    );

    assert.equal(result.manifest.id, id);
  }
});

test("prerelease CLIs below an artifact minimum remain incompatible", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-prerelease-minimum-"));
  const packed = await packFixture(directory, releasePackageRoot);
  const resolved = await servedTarballUrl(packed, t);
  const selectedArtifact = artifactForId("skill-release-with-confidence");

  await assert.rejects(
    () =>
      extractArtifactPackage(
        {
          artifact: selectedArtifact,
          packageName: selectedArtifact.packageName,
          version: packed.version,
          resolved,
          integrity: packed.integrity,
          tag: "next",
          cache: join(directory, "cache"),
          offline: false,
        },
        join(directory, "package"),
        "2.3.0-next.0",
        isolatedNpm(directory),
      ),
    /not compatible/,
  );
});

test("payload hashes include empty directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-payload-hash-"));
  await writeFile(join(directory, "payload.txt"), "payload\n");
  const initialHash = await hashArtifactPayload(directory);

  await mkdir(join(directory, "empty"));
  const withEmptyDirectory = await hashArtifactPayload(directory);
  assert.notEqual(withEmptyDirectory, initialHash);

  await rm(join(directory, "empty"), { recursive: true });
  assert.equal(await hashArtifactPayload(directory), initialHash);
});

const TOKEN = "npm_0123456789abcdefSECRETTOKEN";

/**
 * Serves one packument and its tarball like an npm registry would, recording each request.
 * @param {{ tarball: Buffer, version: string, integrity: string }} packed
 * @param {{ status?: number, repository?: unknown, packument?: string, tarballUrl?: (port: number) => string, redirectTo?: string, listenHost?: string }} [options] `packument` replaces the package document with this raw text. `tarballUrl` replaces the package document's `dist.tarball`. `redirectTo` answers every request with a redirect to that origin. `listenHost` replaces 127.0.0.1 as the address the server listens on.
 */
async function startRegistry(
  packed,
  { status = 200, repository, packument, tarballUrl, redirectTo, listenHost = "127.0.0.1" } = {},
) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (redirectTo) {
      res.writeHead(302, { location: `${redirectTo}${req.url}` });
      res.end();
    } else if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "denied" }));
    } else if (packument !== undefined && !req.url?.endsWith(".tgz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(packument);
    } else if (req.url?.endsWith(".tgz")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(packed.tarball);
    } else {
      const { port } = server.address();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: artifact.packageName,
          "dist-tags": { latest: packed.version },
          versions: {
            [packed.version]: {
              name: artifact.packageName,
              version: packed.version,
              ...(repository ? { repository } : {}),
              dist: {
                tarball: tarballUrl?.(port) ?? `http://127.0.0.1:${port}/-/artifact.tgz`,
                integrity: packed.integrity,
              },
            },
          },
        }),
      );
    }
  });
  await new Promise((done) => server.listen(0, listenHost, done));
  const { port } = server.address();
  return {
    requests,
    host: `127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** @param {string} projectNpmrc @param {string} [userNpmrc] */
async function npmConfigFixture(projectNpmrc, userNpmrc = "") {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-npmrc-"));
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, ".npmrc"), projectNpmrc);
  await writeFile(join(directory, "user.npmrc"), userNpmrc);
  return {
    directory,
    cwd: project,
    cache: join(directory, "cache"),
    env: { npm_config_userconfig: join(directory, "user.npmrc") },
  };
}

test("resolution and extraction use the configured scoped registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-configured-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    });
    assert.equal(resolution.version, packed.version);
    assert.equal(resolution.integrity, packed.integrity);
    assert.deepEqual(resolution.registry, {
      origin: `http://${registry.host}`,
      source: "user .npmrc",
      setting: "@schalkneethling:registry",
    });
    assert.deepEqual(resolution.warnings, []);

    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      { cwd: fixture.cwd, env: fixture.env },
    );
    assert.equal(result.manifest.id, "skill-project-goal");
    assert.equal(registry.requests.length, 2);
  } finally {
    await registry.close();
  }
});

test("a registry.npmjs.org tarball downloads from the artifact scope's registry, and the default registry receives no request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-scope-download-"));
  const packed = await packFixture(directory);
  // The default registry requires authentication; the scope registry serves anonymously and names
  // a registry.npmjs.org tarball, as a mirror of the public registry does.
  const locked = await startRegistry(packed, { status: 401 });
  const scope = await startRegistry(packed, {
    tarballUrl: () => "https://registry.npmjs.org/-/artifact.tgz",
  });
  try {
    const fixture = await npmConfigFixture(
      "",
      `registry=http://${locked.host}/\n@schalkneethling:registry=http://${scope.host}/\n`,
    );
    const npm = { cwd: fixture.cwd, env: fixture.env };
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      ...npm,
    });
    assert.equal(resolution.resolved, "https://registry.npmjs.org/-/artifact.tgz");
    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      npm,
    );
    assert.equal(result.manifest.id, "skill-project-goal");
    assert.deepEqual(
      scope.requests.map(({ url }) => url),
      // pacote requests the package document at npm-package-arg's escapedName: the slash after
      // the scope becomes %2f (npm-package-arg/lib/npa.js).
      [`/${artifact.packageName.replace(/^(@[^/]+)\//, "$1%2f")}`, "/-/artifact.tgz"],
    );
    assert.equal(locked.requests.length, 0);
  } finally {
    await locked.close();
    await scope.close();
  }
});

test("without a scope registry, a registry.npmjs.org tarball downloads from the default registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-default-download-"));
  const packed = await packFixture(directory);
  const mirror = await startRegistry(packed, {
    tarballUrl: () => "https://registry.npmjs.org/-/artifact.tgz",
  });
  try {
    const fixture = await npmConfigFixture("", `registry=http://${mirror.host}/\n`);
    const npm = { cwd: fixture.cwd, env: fixture.env };
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      ...npm,
    });
    await extractArtifactPackage(resolution, join(fixture.directory, "package"), "2.2.0", npm);
    assert.equal(mirror.requests.at(-1)?.url, "/-/artifact.tgz");
  } finally {
    await mirror.close();
  }
});

test("extractArtifactPackage passes the artifact scope's registry to pacote.extract", async (t) => {
  const fixture = await npmConfigFixture(
    `@schalkneethling:registry=https://scoped.example.com/npm/\n`,
    "registry=https://default.example.com/\n",
  );
  /** @type {Record<string, unknown>[]} */
  const calls = [];
  t.mock.method(pacote, "extract", async (_spec, _destination, options) => {
    calls.push(options);
    throw Object.assign(new Error("stop"), { code: "ESTOP" });
  });
  const resolution = {
    artifact,
    packageName: artifact.packageName,
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/-/artifact.tgz",
    integrity: "sha512-AAAA",
    tag: "latest",
    cache: fixture.cache,
    offline: false,
  };
  await assert.rejects(
    extractArtifactPackage(resolution, join(fixture.directory, "package"), "2.2.0", {
      cwd: fixture.cwd,
      env: fixture.env,
    }),
    { code: "ESTOP" },
  );
  assert.equal(calls[0]?.registry, "https://scoped.example.com/npm/");
  assert.equal(calls[0]?.replaceRegistryHost, undefined);
});

test("resolution reports the package's published repository metadata, or null without it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-repository-"));
  const packed = await packFixture(directory);
  const repository = {
    type: "git",
    url: "git+ssh://git@github.com/schalkneethling/create-project-calavera.git",
    directory: "packages/artifacts/skill-project-goal",
  };
  for (const [metadata, expected] of [
    [repository, repository],
    [undefined, null],
  ]) {
    const registry = await startRegistry(packed, { repository: metadata });
    try {
      const fixture = await npmConfigFixture(
        "",
        `@schalkneethling:registry=http://${registry.host}/\n`,
      );
      const resolution = await resolveArtifactPackage({
        id: "skill-project-goal",
        cache: fixture.cache,
        cwd: fixture.cwd,
        env: fixture.env,
      });
      assert.deepEqual(resolution.repository, expected);
    } finally {
      await registry.close();
    }
  }
});

test("a user .npmrc registry applies and the environment takes precedence over it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-precedence-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      "@schalkneethling:registry=http://127.0.0.1:9/\nregistry=http://127.0.0.1:9/\n",
    );
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: {
        ...fixture.env,
        "npm_config_@schalkneethling:registry": `http://${registry.host}/`,
      },
    });
    assert.equal(resolution.version, packed.version);
    assert.equal(registry.requests.length, 1);

    const userOnly = await npmConfigFixture("", `registry=http://${registry.host}/\n`);
    const viaUser = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: userOnly.cache,
      cwd: userOnly.cwd,
      env: userOnly.env,
    });
    assert.equal(viaUser.version, packed.version);
    assert.equal(registry.requests.length, 2);
  } finally {
    await registry.close();
  }
});

test("npm_config_registry from the environment overrides .npmrc files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-env-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture("", "registry=http://127.0.0.1:9/\n");
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: { ...fixture.env, NPM_CONFIG_REGISTRY: `http://${registry.host}/` },
    });
    assert.equal(resolution.version, packed.version);
    assert.equal(registry.requests.length, 1);
  } finally {
    await registry.close();
  }
});

test("a 401 behind a loader diagnostic keeps the message, the notes, and the origin, setting, and layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-unset-failure-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed, { status: 401 });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\nhttps-proxy=http://\${CALAVERA_UNSET_PROXY}/\n`,
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
    assert.match(failure.message, new RegExp(`^The registry http://${registry.host} answered 401`));
    assert.match(failure.message, /Calavera sends no credentials to any registry\./);
    assert.match(failure.message, /CALAVERA_UNSET_PROXY/);
    assert.match(failure.message, /minimal environment/);
    // The wrapped failure stays distinguishable: same code and status, and the fields the update
    // check reads survive the second wrapping.
    assert.equal(failure.code, "E401");
    assert.equal(failure.statusCode, 401);
    assert.equal(failure.origin, `http://${registry.host}`);
    assert.equal(failure.setting, "@schalkneethling:registry");
    assert.equal(failure.layer, "user .npmrc");
    assert.equal(failure.registryOrigin, `http://${registry.host}`);
    assert.equal(failure.cause.code, "E401");
    assert.deepEqual(failure.unsetVariables, ["CALAVERA_UNSET_PROXY"]);
    assert.match(failure.npmDiagnostics.join("\n"), /^Ignored https-proxy in the user \.npmrc/m);
  } finally {
    await registry.close();
  }
});

test("a dist-tag the package does not have fails with ETARGET and the tags it does have", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-missing-tag-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      tag: "next",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the missing tag to reject."),
      (error) => error,
    );
    assert.equal(failure.code, "ETARGET");
    assert.deepEqual(failure.distTags, { latest: packed.version });
  } finally {
    await registry.close();
  }
});

test("a fetch failure behind npm configuration notes keeps its kind", async () => {
  // #993: an ignored project proxy is an npm note, so withNpmDiagnostics wraps the failure;
  // minipass-fetch's `type` must survive the wrapping.
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-invalid-json-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed, { packument: "{ not json" });
  try {
    const fixture = await npmConfigFixture(
      "https-proxy=http://proxy.example.com/\n",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the malformed package document to reject."),
      (error) => error,
    );
    assert.ok(failure.npmDiagnostics.length > 0, "the fixture must produce an npm note");
    assert.ok(failure.cause, "the failure must be wrapped by withNpmDiagnostics");
    assert.equal(failure.code, "FETCH_ERROR");
    assert.equal(failure.type, "invalid-json");
  } finally {
    await registry.close();
  }
});

test("a null package document fails with a registry code and keeps the original as cause", async () => {
  // npm-pick-manifest reads `dist-tags` on the parsed body and throws a TypeError with no code.
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-null-packument-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed, { packument: "null" });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the null package document to reject."),
      (error) => error,
    );
    assert.equal(failure.code, "EBADPACKUMENT");
    assert.equal(
      failure.message,
      `The registry returned a package document for ${artifact.packageName} that Calavera could not read.`,
    );
    assert.ok(failure.cause instanceof TypeError);
    assert.equal(failure.cause.code, undefined);
  } finally {
    await registry.close();
  }
});

test("a missing dist-tag behind npm configuration notes keeps the tags on its cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-missing-tag-notes-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\nhttps-proxy=http://\${CALAVERA_UNSET_PROXY}/\n`,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      tag: "next",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the missing tag to reject."),
      (error) => error,
    );
    assert.equal(failure.code, "ETARGET");
    assert.deepEqual(failure.unsetVariables, ["CALAVERA_UNSET_PROXY"]);
    assert.deepEqual(failure.cause.distTags, { latest: packed.version });
  } finally {
    await registry.close();
  }
});

test("a scope registry with a username and password is used without them, so no request carries an authorization header", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-userinfo-"));
  const packed = await packFixture(directory);
  // The package document names a registry.npmjs.org tarball, so pacote rewrites it onto the
  // scope registry: the rewritten URL must not carry the user information either.
  const registry = await startRegistry(packed, {
    tarballUrl: () => "https://registry.npmjs.org/-/artifact.tgz",
  });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://alice:${TOKEN}@${registry.host}/\n`,
    );
    const npm = { cwd: fixture.cwd, env: fixture.env };
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      ...npm,
    });
    assert.deepEqual(resolution.warnings, [
      "Used @schalkneethling:registry from the user .npmrc without the username and password in its URL: Calavera sends no credentials to any registry.",
    ]);
    await extractArtifactPackage(resolution, join(fixture.directory, "package"), "2.2.0", npm);
    assert.equal(registry.requests.length, 2);
    for (const request of registry.requests) assert.equal(request.authorization, undefined);
    assert.doesNotMatch(inspect(resolution, { depth: 10 }), new RegExp(`${TOKEN}|alice`));
  } finally {
    await registry.close();
  }
});

test("integrity verification is unchanged when the registry is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-configured-integrity-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry({
    ...packed,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    });
    await assert.rejects(
      () =>
        extractArtifactPackage(resolution, join(fixture.directory, "package"), "2.2.0", {
          cwd: fixture.cwd,
          env: fixture.env,
        }),
      /integrity|checksum/i,
    );
  } finally {
    await registry.close();
  }
});

test("a 401 or 403 from the registry names its origin, says Calavera sends no credentials, and drops the registry's text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-auth-failure-"));
  const packed = await packFixture(directory);
  for (const status of [401, 403]) {
    const registry = await startRegistry(packed, { status });
    try {
      const fixture = await npmConfigFixture(
        "",
        `@schalkneethling:registry=http://${registry.host}/path-${TOKEN}/\n`,
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
      assert.equal(
        failure.message,
        [
          `The registry http://${registry.host} answered ${status} for ${artifact.packageName}.`,
          "Calavera sends no credentials to any registry. If this registry requires authentication, Calavera cannot use it: point @schalkneethling:registry in the user .npmrc at a registry that serves Calavera's packages without authentication, such as https://registry.npmjs.org/.",
        ].join("\n"),
      );
      assert.deepEqual(
        [failure.code, failure.statusCode, failure.origin, failure.setting, failure.layer],
        [
          `E${status}`,
          status,
          `http://${registry.host}`,
          "@schalkneethling:registry",
          "user .npmrc",
        ],
      );
      // The cause keeps only the method, code, status, and origin, and prints only with
      // CALAVERA_DEBUG. The registry's own text and the URL path are gone.
      assert.equal(
        failure.cause.message,
        `GET http://${registry.host} answered ${status} (E${status}).`,
      );
      assert.equal(failure.cause.debugOnly, true);
      assert.equal(failure.cause.cause, undefined);
      assert.doesNotMatch(inspect(failure, { depth: 10 }), new RegExp(`${TOKEN}|denied|path-`));
    } finally {
      await registry.close();
    }
  }
});

test("a 403 from a tarball host names the host and the registry setting that named the download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-tarball-403-"));
  const packed = await packFixture(directory);
  const tarballHost = await startRegistry(packed, { status: 403 });
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const npm = { cwd: fixture.cwd, env: fixture.env };
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      ...npm,
    });
    const failure = await extractArtifactPackage(
      { ...resolution, resolved: `http://${tarballHost.host}/-/artifact.tgz?token=${TOKEN}` },
      join(fixture.directory, "package"),
      "2.2.0",
      npm,
    ).then(
      () => assert.fail("Expected the tarball failure to reject."),
      (error) => error,
    );
    assert.equal(
      failure.message,
      [
        `The tarball host http://${tarballHost.host} answered 403 for ${artifact.packageName}@${packed.version}.`,
        `Calavera sends no credentials to any registry or tarball host. The registry http://${registry.host}, from @schalkneethling:registry in the user .npmrc, named this download. If the host requires authentication, point that setting at a registry whose packages download without authentication.`,
      ].join("\n"),
    );
    assert.equal(failure.origin, `http://${tarballHost.host}`);
    assert.doesNotMatch(inspect(failure, { depth: 10 }), new RegExp(`${TOKEN}|denied`));
  } finally {
    await tarballHost.close();
    await registry.close();
  }
});

test("a lookup that a registry redirects to another host that answers 401 names that host and the registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-redirect-401-"));
  const packed = await packFixture(directory);
  const target = await startRegistry(packed, { status: 401 });
  const registry = await startRegistry(packed, { redirectTo: `http://${target.host}` });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the redirected lookup to reject."),
      (error) => error,
    );
    assert.equal(
      failure.message,
      [
        `The host http://${target.host} answered 401 for ${artifact.packageName}.`,
        `Calavera sends no credentials to any registry or host. The registry http://${registry.host}, from @schalkneethling:registry in the user .npmrc, sent this request there. If the host requires authentication, point that setting at a registry that serves Calavera's packages without authentication.`,
      ].join("\n"),
    );
    assert.equal(failure.origin, `http://${target.host}`);
    assert.equal(failure.registryOrigin, `http://${registry.host}`);
    assert.equal(target.requests[0]?.authorization, undefined);
  } finally {
    await target.close();
    await registry.close();
  }
});

test("EOTP, EAUTHIP, and E401 stay distinguishable, and a failure without a URL or setting falls back to the default registry", async (t) => {
  const fixture = await npmConfigFixture("");
  const failures = [];
  for (const code of ["EOTP", "EAUTHIP", "E401"]) {
    t.mock.method(pacote, "manifest", async () => {
      throw Object.assign(new Error(`registry text ${TOKEN}`), {
        code,
        statusCode: 401,
        method: "GET",
      });
    });
    failures.push(
      await resolveArtifactPackage({
        id: "skill-project-goal",
        cache: fixture.cache,
        cwd: fixture.cwd,
        env: fixture.env,
      }).then(
        () => assert.fail("Expected the failure to reject."),
        (error) => error,
      ),
    );
    t.mock.restoreAll();
  }
  assert.deepEqual(
    failures.map(({ code, cause }) => [code, cause.code]),
    [
      ["EOTP", "EOTP"],
      ["EAUTHIP", "EAUTHIP"],
      ["E401", "E401"],
    ],
  );
  assert.equal(
    failures[0].message,
    [
      `The default registry https://registry.npmjs.org answered 401 for ${artifact.packageName}.`,
      "Calavera sends no credentials to any registry. If this registry requires authentication, Calavera cannot use it: configure a registry that serves Calavera's packages without authentication.",
    ].join("\n"),
  );
  assert.deepEqual(
    [failures[0].origin, failures[0].setting, failures[0].layer],
    ["https://registry.npmjs.org", null, "default"],
  );
  assert.doesNotMatch(inspect(failures, { depth: 10 }), new RegExp(TOKEN));
});

test("an invalid registry in .npmrc is reported without echoing credentials", async () => {
  const fixture = await npmConfigFixture(`@schalkneethling:registry=not a url ${TOKEN}\n`);
  await assert.rejects(
    () =>
      resolveArtifactPackage({
        id: "skill-project-goal",
        cache: fixture.cache,
        cwd: fixture.cwd,
        env: fixture.env,
      }),
    (error) => {
      assert.match(error.message, /@schalkneethling:registry/);
      assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(TOKEN));
      return true;
    },
  );
});

test("a project .npmrc cannot select an http registry, so no request is made", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-project-http-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(`@schalkneethling:registry=http://${registry.host}/\n`);
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the http registry to be rejected."),
      (error) => error,
    );
    assert.match(failure.message, /project \.npmrc must be an https URL/);
    assert.equal(registry.requests.length, 0);
  } finally {
    await registry.close();
  }
});

test("a download failure from another host behind the default registry, without a code or method, names the default registry", async (t) => {
  const fixture = await npmConfigFixture("");
  t.mock.method(pacote, "extract", async () => {
    // A non-http URL has no usable origin, so the message falls back to the registry's.
    throw Object.assign(new Error(`registry text ${TOKEN}`), {
      statusCode: 403,
      uri: "https://cdn.example.com/-/artifact.tgz",
    });
  });
  const resolution = {
    artifact,
    packageName: artifact.packageName,
    version: "1.0.0",
    resolved: "https://cdn.example.com/-/artifact.tgz",
    integrity: "sha512-AAAA",
    tag: "latest",
    cache: fixture.cache,
    offline: false,
  };
  const failure = await extractArtifactPackage(
    resolution,
    join(fixture.directory, "package"),
    "2.2.0",
    { cwd: fixture.cwd, env: fixture.env },
  ).then(
    () => assert.fail("Expected the download failure to reject."),
    (error) => error,
  );
  assert.equal(
    failure.message,
    [
      `The tarball host https://cdn.example.com answered 403 for ${artifact.packageName}@1.0.0.`,
      "Calavera sends no credentials to any registry or tarball host. The default registry https://registry.npmjs.org named this download. If the host requires authentication, configure a registry whose packages download without authentication.",
    ].join("\n"),
  );
  assert.equal(failure.code, "E403");
  assert.equal(failure.cause.message, "https://cdn.example.com answered 403 (E403).");

  t.mock.restoreAll();
  t.mock.method(pacote, "extract", async () => {
    throw Object.assign(new Error("denied"), {
      code: "E401",
      statusCode: 401,
      method: "not a method",
      uri: "git+https://cdn.example.com/-/artifact.tgz",
    });
  });
  const fallback = await extractArtifactPackage(
    resolution,
    join(fixture.directory, "package"),
    "2.2.0",
    { cwd: fixture.cwd, env: fixture.env },
  ).then(
    () => assert.fail("Expected the download failure to reject."),
    (error) => error,
  );
  assert.equal(fallback.origin, "https://registry.npmjs.org");
  assert.equal(fallback.cause.message, "https://registry.npmjs.org answered 401 (E401).");
});

test("a user .npmrc registry with a variable stops resolution before any request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-variable-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\${CALAVERA_TEST_TOKEN}/\n`,
    );
    await assert.rejects(
      resolveArtifactPackage({
        id: "skill-project-goal",
        cache: fixture.cache,
        cwd: fixture.cwd,
        env: { ...fixture.env, CALAVERA_TEST_TOKEN: TOKEN },
      }),
      (error) => {
        assert.match(error.message, /in the user \.npmrc contains a variable reference/);
        assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(TOKEN));
        return true;
      },
    );
    assert.equal(registry.requests.length, 0);
  } finally {
    await registry.close();
  }
});

/** @type {ReturnType<typeof packFixture> | undefined} */
let tarballUrlPack;

/** One packed fixture for every #1194 test, which reads it without changing it. */
function packedOnce() {
  tarballUrlPack ??= mkdtemp(join(tmpdir(), "calavera-registry-tarball-url-")).then((directory) =>
    packFixture(directory),
  );
  return tarballUrlPack;
}

/**
 * Resolves the artifact from a loopback registry whose package document names `tarballUrl`, then
 * extracts it with `npmrc` as the user .npmrc. Returns the extraction failure, the registry's
 * requests, and whether anything was written to the destination.
 * @param {{ tarballUrl: (port: number) => string, npmrc?: (host: string) => string }} options
 */
async function extractionFailure({
  tarballUrl,
  npmrc = (host) => `@schalkneethling:registry=http://${host}/\n`,
}) {
  const registry = await startRegistry(await packedOnce(), { tarballUrl });
  try {
    const fixture = await npmConfigFixture("", npmrc(registry.host));
    const options = { cwd: fixture.cwd, env: fixture.env };
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      ...options,
    });
    const destination = join(fixture.directory, "package");
    const failure = await extractArtifactPackage(resolution, destination, "2.2.0", options).then(
      () => assert.fail("Expected the tarball URL to be refused."),
      (error) => error,
    );
    const written = await readdir(destination).then(
      () => true,
      () => false,
    );
    return { failure, requests: registry.requests, written };
  } finally {
    await registry.close();
  }
}

// #1194: pacote picks a fetcher from the text of the tarball spec (FetcherBase.get in
// pacote/lib/fetcher.js, through npm-package-arg). A git URL runs git with the person's SSH agent
// and credential helpers, a file URL or path reads this machine, and plain http can be changed on
// the way. Calavera fetches a tarball only from an https URL, or an http URL on a loopback host.
const refusalPrefix = `Calavera did not fetch ${artifact.packageName}:`;
const TARBALL_RULE =
  "Calavera fetches artifact tarballs only from https URLs, or from http URLs on localhost, 127.0.0.1, or ::1.";
const REFUSED_TARBALL_URLS = [
  {
    form: "a git+ssh URL",
    url: "git+ssh://git@github.com/calavera-fixture/artifact.git",
    protocol: "git+ssh:",
    reason: "uses the protocol git+ssh:",
  },
  {
    form: "a git+https URL",
    url: "git+https://github.com/calavera-fixture/artifact.git",
    protocol: "git+https:",
    reason: "uses the protocol git+https:",
  },
  {
    form: "a git URL",
    url: "git://github.com/calavera-fixture/artifact.git",
    protocol: "git:",
    reason: "uses the protocol git:",
  },
  {
    form: "a file URL",
    url: "file:///calavera-fixture/artifact.tgz",
    protocol: "file:",
    reason: "uses the protocol file:",
  },
  {
    form: "an http URL on a non-loopback host",
    url: "http://registry.example.test/calavera-fixture/artifact.tgz",
    protocol: "http:",
    reason: "uses http: on a host that is not loopback",
  },
  {
    form: "an http URL on a host that only starts like a loopback address",
    url: "http://127.0.0.1.example.test/calavera-fixture/artifact.tgz",
    protocol: "http:",
    reason: "uses http: on a host that is not loopback",
  },
  {
    form: "a relative path",
    url: "-/calavera-fixture/artifact.tgz",
    protocol: null,
    reason: "is not an absolute URL",
  },
  {
    form: "an scp-style git address",
    url: "git@github.com:calavera-fixture/artifact.git",
    protocol: null,
    reason: "is an scp-style git address",
  },
  // The WHATWG URL parser drops a leading space, but npm-package-arg then reads a local path.
  {
    form: "an https URL after a leading space",
    url: " https://registry.example.test/calavera-fixture/artifact.tgz",
    protocol: null,
    reason: "does not start with its protocol",
  },
];

for (const { form, url, protocol, reason } of REFUSED_TARBALL_URLS) {
  test(`#1194: ${form} as the tarball URL is refused before pacote fetches it`, async () => {
    const { failure, requests, written } = await extractionFailure({ tarballUrl: () => url });
    assert.equal(failure.code, "EBADTARBALLURL");
    assert.equal(failure.packageName, artifact.packageName);
    assert.equal(failure.protocol, protocol);
    assert.equal(failure.message, `${refusalPrefix} its tarball URL ${reason}. ${TARBALL_RULE}`);
    // The error quotes no other packument text, and only the package document was requested.
    assert.doesNotMatch(inspect(failure, { depth: 10 }), /calavera-fixture|example\.test/);
    assert.equal(requests.length, 1);
    assert.equal(written, false);
  });
}

test("#1194: an https URL that npm-package-arg reads as a git repository is refused, not cloned", async () => {
  const { failure, requests, written } = await extractionFailure({
    tarballUrl: () => "https://github.com/calavera-fixture/artifact",
  });
  assert.equal(failure.code, "EBADTARBALLURL");
  assert.equal(failure.protocol, "https:");
  assert.equal(
    failure.message,
    `${refusalPrefix} its tarball URL names a git repository, which Calavera does not fetch. ${TARBALL_RULE}`,
  );
  assert.doesNotMatch(inspect(failure, { depth: 10 }), /calavera-fixture|github\.com/);
  assert.equal(requests.length, 1);
  assert.equal(written, false);
});

/**
 * Extracts a registry.npmjs.org tarball with `userNpmrc` as the user .npmrc, while pacote.extract
 * is mocked to record its options and stop, so nothing is fetched or looked up.
 * @param {import("node:test").TestContext} t
 * @param {string} userNpmrc
 */
async function extractNpmjsTarball(t, userNpmrc) {
  const fixture = await npmConfigFixture("", userNpmrc);
  /** @type {Record<string, unknown>[]} */
  const calls = [];
  t.mock.method(pacote, "extract", async (_spec, _destination, options) => {
    calls.push(options);
    throw Object.assign(new Error("stop"), { code: "ESTOP" });
  });
  const failure = await extractArtifactPackage(
    {
      artifact,
      packageName: artifact.packageName,
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/calavera-fixture/-/artifact.tgz",
      integrity: "sha512-AAAA",
      tag: "latest",
      cache: fixture.cache,
      offline: false,
    },
    join(fixture.directory, "package"),
    "2.2.0",
    { cwd: fixture.cwd, env: fixture.env },
  ).then(
    () => assert.fail("Expected the extraction to stop."),
    (error) => error,
  );
  return { failure, calls };
}

// pacote moves a registry.npmjs.org tarball onto the artifact scope's registry, which
// extractArtifactPackage passes as `registry` (ADR-0021 Decision 4), so the check must judge the
// URL on that registry, not on the default registry.
test("#1194: a registry.npmjs.org tarball rewritten onto a non-loopback http scope registry is refused", async (t) => {
  const { failure, calls } = await extractNpmjsTarball(
    t,
    "@schalkneethling:registry=http://registry.example.test/\nregistry=http://127.0.0.1:9/\n",
  );
  assert.equal(failure.code, "EBADTARBALLURL");
  assert.equal(failure.protocol, "http:");
  assert.equal(
    failure.message,
    `${refusalPrefix} its tarball URL uses http: on a host that is not loopback after pacote moves it onto the configured registry. ${TARBALL_RULE}`,
  );
  assert.doesNotMatch(inspect(failure, { depth: 10 }), /calavera-fixture|example\.test/);
  assert.equal(calls.length, 0);
});

test("#1194: a registry.npmjs.org tarball rewritten onto a loopback http scope registry is accepted", async (t) => {
  const { failure, calls } = await extractNpmjsTarball(
    t,
    "@schalkneethling:registry=http://127.0.0.1:9/\nregistry=http://registry.example.test/\n",
  );
  assert.equal(failure.code, "ESTOP");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.registry, "http://127.0.0.1:9/");
});

test("#1194: an http tarball URL on localhost is fetched", async () => {
  // Listening on :: also accepts IPv4, so localhost reaches it whichever address it names first.
  const registry = await startRegistry(await packedOnce(), {
    listenHost: "::",
    tarballUrl: (port) => `http://localhost:${port}/-/artifact.tgz`,
  });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const options = { cwd: fixture.cwd, env: fixture.env };
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      ...options,
    });
    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      options,
    );
    assert.equal(result.manifest.id, "skill-project-goal");
    assert.deepEqual(
      registry.requests.map(({ url }) => url?.endsWith(".tgz")),
      [false, true],
    );
  } finally {
    await registry.close();
  }
});

test(
  "aborting the signal ends a lookup the registry never answers (#1138)",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "calavera-registry-abort-"));
    const controller = new AbortController();
    /** @type {string[]} */
    const requests = [];
    // Accepts the request, never answers, and aborts the lookup once the request has arrived, so
    // the test depends on the order of events rather than on a timer.
    const server = createServer((request) => {
      requests.push(request.url ?? "");
      controller.abort(new Error("deadline"));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    try {
      await assert.rejects(
        resolveArtifactPackage({
          id: "skill-project-goal",
          cache: join(directory, "cache"),
          cwd: directory,
          env: {
            npm_config_userconfig: join(directory, "missing.npmrc"),
            npm_config_registry: `http://127.0.0.1:${port}/`,
          },
          signal: controller.signal,
        }),
        { code: "FETCH_ABORTED" },
      );
      assert.equal(requests.length, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(() => done(undefined)));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("beforeLookup receives the registry before any request, and an error it throws sends none (#1138)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-before-lookup-"));
  /** @type {string[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(404);
    response.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const skip = new Error("skipped");
  /** @type {unknown[]} */
  const seen = [];
  try {
    await assert.rejects(
      resolveArtifactPackage({
        id: "skill-project-goal",
        cache: join(directory, "cache"),
        cwd: directory,
        env: {
          npm_config_userconfig: join(directory, "missing.npmrc"),
          npm_config_registry: `http://127.0.0.1:${port}/`,
        },
        beforeLookup: (registry) => {
          seen.push({ origin: registry.origin, url: registry.url, requests: requests.length });
          throw skip;
        },
      }),
      (error) => error === skip,
    );
    assert.deepEqual(seen, [
      { origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/`, requests: 0 },
    ]);
    assert.deepEqual(requests, []);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(() => done(undefined)));
    await rm(directory, { recursive: true, force: true });
  }
});
