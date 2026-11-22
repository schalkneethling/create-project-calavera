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

test("verified extraction checks package identity, manifest compatibility, and payload hash", async () => {
  const destination = await mkdtemp(join(tmpdir(), "calavera-registry-extract-"));
  const packed = await packFixture(destination);
  const result = await extractArtifactPackage(
    {
      artifact,
      packageName: artifact.packageName,
      version: packed.version,
      resolved: packed.path,
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
          resolved: packed.path,
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

test("verified extraction rejects a tarball that fails npm integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-integrity-"));
  const packed = await packFixture(directory);
  const tarballPath = join(directory, "corrupted.tgz");
  await writeFile(tarballPath, packed.tarball);

  await assert.rejects(
    () =>
      extractArtifactPackage(
        {
          artifact,
          packageName: artifact.packageName,
          version: packed.version,
          resolved: tarballPath,
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

test("prerelease CLIs accept compatible stable-line and prerelease artifacts", async () => {
  for (const [id, packageRoot] of [
    ["skill-project-goal", projectGoalPackageRoot],
    ["skill-release-with-confidence", releasePackageRoot],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `calavera-registry-${id}-`));
    const packed = await packFixture(directory, packageRoot);
    const selectedArtifact = artifactForId(id);
    const result = await extractArtifactPackage(
      {
        artifact: selectedArtifact,
        packageName: selectedArtifact.packageName,
        version: packed.version,
        resolved: packed.path,
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

test("prerelease CLIs below an artifact minimum remain incompatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-prerelease-minimum-"));
  const packed = await packFixture(directory, releasePackageRoot);
  const selectedArtifact = artifactForId("skill-release-with-confidence");

  await assert.rejects(
    () =>
      extractArtifactPackage(
        {
          artifact: selectedArtifact,
          packageName: selectedArtifact.packageName,
          version: packed.version,
          resolved: packed.path,
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
 * @param {{ version: string, tarball: Buffer, integrity: string }} packed
 * @param {{ status?: number }} [options]
 */
/**
 * @param {{ tarball: Buffer, version: string, integrity: string }} packed
 * @param {{ status?: number, repository?: unknown, packument?: string }} [options] `packument` replaces the package document with this raw text.
 */
async function startRegistry(packed, { status = 200, repository, packument } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "denied" }));
    } else if (packument !== undefined && !req.url?.endsWith(".tgz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(packument);
    } else if (req.url?.endsWith(".tgz")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(packed.tarball);
    } else {
      const origin = `http://127.0.0.1:${server.address().port}`;
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
              dist: { tarball: `${origin}/-/artifact.tgz`, integrity: packed.integrity },
            },
          },
        }),
      );
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
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

test("invariant 1: resolution and extraction use the configured scoped registry but send its token only over https", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-configured-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_authToken=\${CALAVERA_TEST_TOKEN}\n`,
    );
    const env = { ...fixture.env, CALAVERA_TEST_TOKEN: TOKEN };

    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env,
    });
    assert.equal(resolution.version, packed.version);
    assert.equal(resolution.integrity, packed.integrity);
    assert.deepEqual(resolution.registry, {
      origin: `http://${registry.host}`,
      source: "user .npmrc",
    });
    assert.match(resolution.warnings.join("\n"), /uses http, so Calavera sends no credentials/);

    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      { cwd: fixture.cwd, env },
    );
    assert.equal(result.manifest.id, "skill-project-goal");

    assert.equal(registry.requests.length, 2);
    for (const request of registry.requests) {
      assert.equal(request.authorization, undefined);
    }
  } finally {
    await registry.close();
  }
});

test("invariant 1: a registry.npmjs.org tarball that pacote moves onto an http registry is fetched without a token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-rewritten-tarball-"));
  const packed = await packFixture(directory);
  const mirror = await startRegistry(packed);
  try {
    // pacote moves a registry.npmjs.org tarball onto the default registry, here a plain-http one.
    const fixture = await npmConfigFixture(
      "",
      `registry=http://${mirror.host}/\n//${mirror.host}/:_authToken=${TOKEN}\n//registry.npmjs.org/:_authToken=${TOKEN}\n`,
    );
    const resolution = {
      artifact,
      packageName: artifact.packageName,
      version: packed.version,
      resolved: "https://registry.npmjs.org/-/artifact.tgz",
      integrity: packed.integrity,
      tag: "latest",
      cache: fixture.cache,
      offline: false,
    };
    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      {
        cwd: fixture.cwd,
        env: fixture.env,
      },
    );
    assert.equal(result.manifest.id, "skill-project-goal");
    assert.equal(mirror.requests.length, 1);
    assert.equal(mirror.requests[0]?.authorization, undefined);
  } finally {
    await mirror.close();
  }
});

test("invariant 1: an http tarball URL from an https registry is fetched without the registry's token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-http-tarball-"));
  const packed = await packFixture(directory);
  const tarballHost = await startRegistry(packed);
  try {
    // The registry is https and has a token; the package document named an http tarball on a host
    // with the same token, as a registry that redirects artifacts to a plain-http mirror would.
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=https://${tarballHost.host}/\n//${tarballHost.host}/:_authToken=${TOKEN}\n`,
    );
    const resolution = {
      artifact,
      packageName: artifact.packageName,
      version: packed.version,
      resolved: `http://${tarballHost.host}/-/artifact.tgz`,
      integrity: packed.integrity,
      tag: "latest",
      cache: fixture.cache,
      offline: false,
    };
    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      {
        cwd: fixture.cwd,
        env: fixture.env,
      },
    );
    assert.equal(result.manifest.id, "skill-project-goal");
    assert.equal(tarballHost.requests.length, 1);
    assert.equal(tarballHost.requests[0]?.authorization, undefined);
  } finally {
    await tarballHost.close();
  }
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

test("a token whose environment variable is unset is not sent as a literal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-unset-token-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_authToken=\${CALAVERA_UNSET_TOKEN}\n`,
    );
    await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    });
    assert.equal(registry.requests[0].authorization, undefined);
  } finally {
    await registry.close();
  }
});

test("a registry failure names the ignored token entry and the unset variable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-unset-failure-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed, { status: 401 });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_authToken=\${CALAVERA_UNSET_TOKEN}\n`,
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
    assert.match(failure.message, new RegExp(`//${registry.host}/:_authToken`));
    assert.match(failure.message, /CALAVERA_UNSET_TOKEN/);
    assert.match(failure.message, /minimal environment/);
    // The wrapped failure stays distinguishable: same code and status, original error as cause.
    assert.equal(failure.code, "E401");
    assert.equal(failure.statusCode, 401);
    assert.equal(failure.cause.code, "E401");
    // #993: the notes are also structured, so a caller that withholds the registry's message can
    // still name what Calavera ignored. They never contain a value.
    assert.deepEqual(failure.unsetVariables, ["CALAVERA_UNSET_TOKEN"]);
    assert.ok(
      failure.npmDiagnostics.some(
        (/** @type {string} */ note) =>
          /^Ignored (\S+) in the /.exec(note)?.[1] === `//${registry.host}/:_authToken`,
      ),
      failure.npmDiagnostics.join("\n"),
    );
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
  // #993: the plain-text credentials warning for an http registry with a token is an npm note, so
  // withNpmDiagnostics wraps the failure; minipass-fetch's `type` must survive the wrapping.
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-invalid-json-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed, { packument: "{ not json" });
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_authToken=token-value\n`,
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
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_authToken=\${CALAVERA_UNSET_TOKEN}\n`,
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
    assert.deepEqual(failure.unsetVariables, ["CALAVERA_UNSET_TOKEN"]);
    assert.deepEqual(failure.cause.distTags, { latest: packed.version });
  } finally {
    await registry.close();
  }
});

test("a project .npmrc token that references a variable is not sent, and the warning says so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-project-variable-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      `//${registry.host}/:_authToken=\${CALAVERA_TEST_TOKEN}\n`,
      `@schalkneethling:registry=http://${registry.host}/\n`,
    );
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: { ...fixture.env, CALAVERA_TEST_TOKEN: TOKEN },
    });
    assert.equal(registry.requests[0].authorization, undefined);
    assert.equal(resolution.warnings.length, 1);
    assert.match(resolution.warnings[0], new RegExp(`//${registry.host}/:_authToken`));
    assert.match(resolution.warnings[0], /project \.npmrc/);
    assert.doesNotMatch(inspect(resolution, { depth: 10 }), new RegExp(TOKEN));
  } finally {
    await registry.close();
  }
});

test("a token for one host is not sent to a registry on another host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-redirect-"));
  const packed = await packFixture(directory);
  const trusted = await startRegistry(packed);
  const redirected = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${redirected.host}/\n//${trusted.host}/:_authToken=${TOKEN}\n`,
    );
    await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    });
    assert.equal(redirected.requests.length, 1);
    assert.equal(redirected.requests[0].authorization, undefined);
    assert.equal(trusted.requests.length, 0);
  } finally {
    await trusted.close();
    await redirected.close();
  }
});

test("invariant 1: _auth and username with _password are not sent as Basic credentials over http", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-basic-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const encoded = Buffer.from("alice:pw").toString("base64");
    const withAuth = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_auth=${encoded}\n`,
    );
    await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: withAuth.cache,
      cwd: withAuth.cwd,
      env: withAuth.env,
    });
    assert.equal(registry.requests[0].authorization, undefined);

    const withPassword = await npmConfigFixture(
      "",
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:username=alice\n//${registry.host}/:_password=${Buffer.from("pw").toString("base64")}\n`,
    );
    await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: withPassword.cache,
      cwd: withPassword.cwd,
      env: withPassword.env,
    });
    assert.equal(registry.requests[1].authorization, undefined);
  } finally {
    await registry.close();
  }
});

test("a registry URL with credentials is rejected before any request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-userinfo-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed, { status: 401 });
  try {
    const fixture = await npmConfigFixture(
      `@schalkneethling:registry=https://alice:${TOKEN}@${registry.host}/\n`,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the registry URL to be rejected."),
      (error) => error,
    );
    assert.match(failure.message, /_authToken/);
    assert.doesNotMatch(inspect(failure, { depth: 10 }), new RegExp(`${TOKEN}|alice`));
    assert.equal(registry.requests.length, 0);
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

test("registry failures never expose the token from .npmrc", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-redaction-"));
  const packed = await packFixture(directory);
  for (const status of [401, 403]) {
    const registry = await startRegistry(packed, { status });
    try {
      const fixture = await npmConfigFixture(
        `//${registry.host}/:_authToken=${TOKEN}\n`,
        `@schalkneethling:registry=http://${registry.host}/\n`,
      );
      const options = { cwd: fixture.cwd, env: fixture.env };
      const failure = await resolveArtifactPackage({
        id: "skill-project-goal",
        cache: fixture.cache,
        ...options,
      }).then(
        () => assert.fail("Expected the registry failure to reject."),
        (error) => error,
      );
      assert.ok(registry.requests.length > 0);
      // Invariant 1: the http registry receives no token, and the failure never names it.
      assert.equal(registry.requests[0].authorization, undefined);
      assert.doesNotMatch(inspect(failure, { depth: 10 }), new RegExp(TOKEN));
      assert.match(failure.message, /\b(401|403)\b|denied|E\d{3}/i);
    } finally {
      await registry.close();
    }
  }
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

test("a project .npmrc that selects an http registry cannot receive the user token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-project-http-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      `@schalkneethling:registry=http://${registry.host}/\n`,
      `//${registry.host}/:_authToken=${TOKEN}\n`,
    );
    const failure = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
    }).then(
      () => assert.fail("Expected the http registry to be rejected."),
      (error) => error,
    );
    assert.match(failure.message, /project \.npmrc/);
    assert.doesNotMatch(inspect(failure, { depth: 10 }), new RegExp(TOKEN));
    assert.equal(registry.requests.length, 0);
  } finally {
    await registry.close();
  }
});
