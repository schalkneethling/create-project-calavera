// Tests for resolvePackageDistTag, the dist-tag lookup behind the CLI version notice (#675,
// ADR-0019 Decision 3): the abbreviated package document, the configured registry, no retries,
// an abort signal, and nothing written to disk.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePackageDistTag } from "../src/registry.js";

const NAME = "create-project-calavera";

/**
 * A registry on 127.0.0.1 that answers every request with `respond`.
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void} respond
 */
async function startRegistry(respond) {
  /** @type {{ url: string | undefined, accept: string | undefined, authorization: string | undefined }[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      accept: request.headers.accept,
      authorization: request.headers.authorization,
    });
    respond(request, response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}/`,
    host: `127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done(undefined));
      }),
  };
}

/** @param {Record<string, string>} distTags */
function packument(distTags) {
  return JSON.stringify({
    name: NAME,
    "dist-tags": distTags,
    versions: Object.fromEntries(
      Object.values(distTags).map((version) => [version, { name: NAME, version }]),
    ),
  });
}

/**
 * A project folder and an environment that reach no developer configuration: the user .npmrc is a
 * missing file, and the registry comes from `npm_config_registry`.
 * @param {string} registry
 */
async function isolatedContext(registry) {
  const cwd = await mkdtemp(join(tmpdir(), "calavera-dist-tag-"));
  return {
    cwd,
    env: { npm_config_userconfig: join(cwd, "missing.npmrc"), npm_config_registry: registry },
  };
}

test("resolves a dist-tag from the configured registry with the abbreviated document", async (t) => {
  const registry = await startRegistry((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(packument({ latest: "7.1.0", next: "8.0.0-beta.1" }));
  });
  const context = await isolatedContext(registry.url);
  t.after(async () => {
    await registry.close();
    await rm(context.cwd, { recursive: true, force: true });
  });

  assert.equal(
    await resolvePackageDistTag({ packageName: NAME, tag: "latest", ...context }),
    "7.1.0",
  );
  assert.equal(
    await resolvePackageDistTag({ packageName: NAME, tag: "next", ...context }),
    "8.0.0-beta.1",
  );
  assert.equal(registry.requests[0]?.url, `/${NAME}`);
  // pacote's abbreviated document (corgi) first; the full document only as a fallback.
  assert.match(registry.requests[0]?.accept ?? "", /^application\/vnd\.npm\.install-v1\+json/);
  // No cache option, so nothing is written in the project or anywhere else it names.
  assert.deepEqual(await readdir(context.cwd), []);
});

test("sends the user .npmrc credentials for the registry it asks", async (t) => {
  const registry = await startRegistry((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(packument({ latest: "7.1.0" }));
  });
  const cwd = await mkdtemp(join(tmpdir(), "calavera-dist-tag-auth-"));
  t.after(async () => {
    await registry.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const userconfig = join(cwd, "user.npmrc");
  await writeFile(userconfig, `registry=${registry.url}\n//${registry.host}/:_authToken=abc123\n`);

  await resolvePackageDistTag({
    packageName: NAME,
    tag: "latest",
    cwd,
    env: { npm_config_userconfig: userconfig },
  });
  assert.equal(registry.requests[0]?.authorization, "Bearer abc123");
});

test("a failed response is not retried", async (t) => {
  const registry = await startRegistry((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end("{}");
  });
  const context = await isolatedContext(registry.url);
  t.after(async () => {
    await registry.close();
    await rm(context.cwd, { recursive: true, force: true });
  });

  await assert.rejects(() =>
    resolvePackageDistTag({ packageName: NAME, tag: "latest", ...context }),
  );
  // make-fetch-happen retries a 5xx response when it is given retries. npm-registry-fetch 20 has no
  // default for fetchRetries, so this also passes without the explicit fetchRetries: 0, which
  // keeps the behavior if a later default adds retries.
  assert.equal(registry.requests.length, 1);
});

test("an abort signal ends a request the registry never answers", async (t) => {
  const registry = await startRegistry(() => {
    // Accept the connection and never answer.
  });
  const context = await isolatedContext(registry.url);
  t.after(async () => {
    await registry.close();
    await rm(context.cwd, { recursive: true, force: true });
  });

  const started = performance.now();
  await assert.rejects(() =>
    resolvePackageDistTag({
      packageName: NAME,
      tag: "latest",
      ...context,
      signal: AbortSignal.timeout(200),
    }),
  );
  assert.ok(performance.now() - started < 5_000, "the abort did not end the request");
});

test("a dist-tag that names no valid version is refused", async (t) => {
  const registry = await startRegistry((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: NAME,
        "dist-tags": { latest: "not-a-version" },
        versions: { "not-a-version": { name: NAME, version: "not-a-version" } },
      }),
    );
  });
  const context = await isolatedContext(registry.url);
  t.after(async () => {
    await registry.close();
    await rm(context.cwd, { recursive: true, force: true });
  });

  await assert.rejects(
    () => resolvePackageDistTag({ packageName: NAME, tag: "latest", ...context }),
    {
      message: `The registry named no valid version for ${NAME}@latest.`,
    },
  );
});

/**
 * A project folder whose user .npmrc holds `npmrc`, with no registry variable.
 * @param {string} npmrc
 */
async function userNpmrcContext(npmrc) {
  const cwd = await mkdtemp(join(tmpdir(), "calavera-dist-tag-proxy-"));
  await writeFile(join(cwd, "user.npmrc"), npmrc);
  return { cwd, env: { npm_config_userconfig: join(cwd, "user.npmrc") } };
}

test("a proxy set only in the user .npmrc carries the request (#1064)", async (t) => {
  const proxy = await startRegistry((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(packument({ latest: "7.1.0" }));
  });
  // The registry host does not resolve, so the answer can only come through the proxy.
  const context = await userNpmrcContext(
    `registry=http://registry.calavera.invalid/\nproxy=${proxy.url}\n`,
  );
  t.after(async () => {
    await proxy.close();
    await rm(context.cwd, { recursive: true, force: true });
  });

  assert.equal(
    await resolvePackageDistTag({ packageName: NAME, tag: "latest", ...context }),
    "7.1.0",
  );
  // An http proxy receives the absolute URL of the request.
  assert.deepEqual(
    proxy.requests.map(({ url }) => url),
    [`http://registry.calavera.invalid/${NAME}`],
  );
});

test("a host in the .npmrc noproxy skips the .npmrc proxy (#1064)", async (t) => {
  const proxy = await startRegistry((_request, response) => {
    response.writeHead(502);
    response.end();
  });
  const registry = await startRegistry((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(packument({ latest: "7.2.0" }));
  });
  const context = await userNpmrcContext(
    `registry=${registry.url}\nproxy=${proxy.url}\nnoproxy=127.0.0.1\n`,
  );
  t.after(async () => {
    await proxy.close();
    await registry.close();
    await rm(context.cwd, { recursive: true, force: true });
  });

  assert.equal(
    await resolvePackageDistTag({ packageName: NAME, tag: "latest", ...context }),
    "7.2.0",
  );
  assert.equal(proxy.requests.length, 0);
  assert.equal(registry.requests.length, 1);
});
