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
async function startRegistry(packed, { status = 200 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "denied" }));
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

test("resolution and extraction use the project .npmrc scoped registry and token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-configured-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      `@schalkneethling:registry=http://${registry.host}/\n`,
      `//${registry.host}/:_authToken=\${CALAVERA_TEST_TOKEN}\n`,
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
    assert.deepEqual(resolution.registry, { host: registry.host, source: "project .npmrc" });

    const result = await extractArtifactPackage(
      resolution,
      join(fixture.directory, "package"),
      "2.2.0",
      { cwd: fixture.cwd, env },
    );
    assert.equal(result.manifest.id, "skill-project-goal");

    assert.equal(registry.requests.length, 2);
    for (const request of registry.requests) {
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
    }
  } finally {
    await registry.close();
  }
});

test("a user .npmrc registry applies and the project .npmrc takes precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-precedence-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      `@schalkneethling:registry=http://${registry.host}/\n`,
      "@schalkneethling:registry=http://127.0.0.1:9/\nregistry=http://127.0.0.1:9/\n",
    );
    const resolution = await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: fixture.cache,
      cwd: fixture.cwd,
      env: fixture.env,
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
    const fixture = await npmConfigFixture("registry=http://127.0.0.1:9/\n");
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
      `@schalkneethling:registry=http://${registry.host}/\n`,
      `//${registry.host}/:_authToken=\${CALAVERA_UNSET_TOKEN}\n`,
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
      `@schalkneethling:registry=http://${registry.host}/\n`,
      `//${registry.host}/:_authToken=\${CALAVERA_UNSET_TOKEN}\n`,
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
      `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_authToken=\${CALAVERA_TEST_TOKEN}\n`,
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
    assert.doesNotMatch(inspect(resolution, { depth: 10 }), new RegExp(TOKEN));
  } finally {
    await registry.close();
  }
});

test("a token for one host is not sent to a registry the project redirects to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-redirect-"));
  const packed = await packFixture(directory);
  const trusted = await startRegistry(packed);
  const redirected = await startRegistry(packed);
  try {
    const fixture = await npmConfigFixture(
      `@schalkneethling:registry=http://${redirected.host}/\n`,
      `//${trusted.host}/:_authToken=${TOKEN}\n`,
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

test("_auth and username with _password authenticate with Basic credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-basic-"));
  const packed = await packFixture(directory);
  const registry = await startRegistry(packed);
  try {
    const encoded = Buffer.from("alice:pw").toString("base64");
    const withAuth = await npmConfigFixture(
      `@schalkneethling:registry=http://${registry.host}/\n`,
      `//${registry.host}/:_auth=${encoded}\n`,
    );
    await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: withAuth.cache,
      cwd: withAuth.cwd,
      env: withAuth.env,
    });
    assert.equal(registry.requests[0].authorization, `Basic ${encoded}`);

    const withPassword = await npmConfigFixture(
      `@schalkneethling:registry=http://${registry.host}/\n`,
      `//${registry.host}/:username=alice\n//${registry.host}/:_password=${Buffer.from("pw").toString("base64")}\n`,
    );
    await resolveArtifactPackage({
      id: "skill-project-goal",
      cache: withPassword.cache,
      cwd: withPassword.cwd,
      env: withPassword.env,
    });
    assert.equal(registry.requests[1].authorization, `Basic ${encoded}`);
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
      `@schalkneethling:registry=http://alice:${TOKEN}@${registry.host}/\n`,
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
    const fixture = await npmConfigFixture(`@schalkneethling:registry=http://${registry.host}/\n`);
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
        `@schalkneethling:registry=http://${registry.host}/\n//${registry.host}/:_authToken=${TOKEN}\n`,
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
      assert.equal(registry.requests[0].authorization, `Bearer ${TOKEN}`);
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
