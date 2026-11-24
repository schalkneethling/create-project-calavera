// Redirects during artifact lookups and downloads (#1207). make-fetch-happen follows a redirect
// itself and asks minipass-fetch for each hop with its own request, so every hop reaches the
// `agent` option Calavera passes. These tests use local servers only: https servers on 127.0.0.1
// and localhost with a certificate generated for the test, and a local http proxy that stands in
// for every plain-http host that is not loopback, such as registry.example.test, so no name is
// looked up and nothing leaves this machine.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pacote from "pacote";

import { artifactForId } from "../src/catalog.js";
import * as npmConfig from "../src/npm-config.js";
import {
  extractArtifactPackage,
  resolveArtifactPackage,
  resolvePackageDistTag,
} from "../src/registry.js";
import { redirectGuard } from "../src/redirect-guard.js";
import { removeTemporaryDirectories, temporaryDirectory } from "./temporary-directory.mjs";

const execFileAsync = promisify(execFile);
// @npmcli/agent is CommonJS, and Node cannot see `cache` as a named export of it.
/** @type {{ clear: () => void, agent: Map<string, unknown>, proxy: Map<string, unknown> }} */
const agentCache = createRequire(import.meta.url)("@npmcli/agent").cache;
const artifact = artifactForId("skill-project-goal");
const packageRoot = fileURLToPath(new URL("../../artifacts/skill-project-goal/", import.meta.url));
// A plain-http host that is not loopback. The local proxy answers for it.
const REMOTE_HTTP = "http://registry.example.test";
// Whether a request the test proxy receives is for the registry host itself. The origin is compared
// exactly, so a longer host that starts with the same text is not the registry.
const isRemote = (/** @type {string} */ url) => new URL(url).origin === new URL(REMOTE_HTTP).origin;
const DOWNGRADE_RULE =
  "Calavera does not follow a redirect from https to plain http, except to localhost, 127.0.0.1, or ::1.";
const HOST_RULE =
  "Calavera follows a redirect over plain http only to the registry's own host, or to localhost, 127.0.0.1, or ::1.";
const TARBALL_RULE =
  "Calavera fetches artifact tarballs only from https URLs, or from http URLs on localhost, 127.0.0.1, or ::1.";

test.afterEach(removeTemporaryDirectories);

/** @type {Promise<{ key: string, cert: string }> | undefined} */
let certificate;

/**
 * A certificate for localhost and 127.0.0.1, made with openssl for this test process and trusted
 * by it only. npm-registry-fetch always verifies certificates (`strictSSL: true`), so the https
 * servers need one the process trusts.
 */
function testCertificate() {
  certificate ??= temporaryDirectory("calavera-redirect-cert-").then(async (directory) => {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    const pair = { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
    setDefaultCACertificates([...getCACertificates("default"), pair.cert]);
    return pair;
  });
  return certificate;
}

/** @type {Promise<{ tarball: Buffer, version: string, integrity: string }> | undefined} */
let packedFixture;

function packed() {
  packedFixture ??= (async () => {
    // Every test of this file serves the same tarball, which stays in memory after the folder
    // is removed.
    const directory = await temporaryDirectory("calavera-redirect-pack-");
    await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: packageRoot });
    const name = (await readdir(directory)).find((entry) => entry.endsWith(".tgz"));
    if (!name) throw new Error("Fixture package did not produce a tarball.");
    const tarball = await readFile(join(directory, name));
    return {
      tarball,
      version: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    };
  })();
  return packedFixture;
}

/**
 * A server that answers each request with a redirect to the URL `redirect` returns, or with a package document and tarball when
 * `redirect` returns nothing. `secure` serves https with the test certificate. `cacheable` lets
 * make-fetch-happen store the 301 for five minutes.
 * @param {{ secure: boolean, host: "127.0.0.1" | "localhost", tarballUrl?: (origin: string) => string, redirect?: (path: string) => string | undefined, cacheable?: boolean }} options
 */
async function startServer({ secure, host, tarballUrl, redirect, cacheable = false }) {
  const fixture = await packed();
  /** @type {string[]} */
  const requests = [];
  /** @type {import("node:http").RequestListener} */
  const listener = (req, res) => {
    requests.push(req.url ?? "");
    const location = redirect?.(req.url ?? "/");
    if (location) {
      res.writeHead(301, { location, ...(cacheable ? { "cache-control": "max-age=300" } : {}) });
      res.end();
    } else if (req.url?.endsWith(".tgz")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(fixture.tarball);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(packument(fixture, tarballUrl?.(origin) ?? `${origin}/-/artifact.tgz`));
    }
  };
  const server = secure
    ? createHttpsServer(await testCertificate(), listener)
    : createHttpServer(listener);
  await new Promise((done) => server.listen(0, host, done));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `${secure ? "https" : "http"}://${host}:${port}`;
  return { origin, requests, close: () => new Promise((done) => server.close(done)) };
}

/**
 * @param {{ version: string, integrity: string }} fixture
 * @param {string} tarball
 */
function packument(fixture, tarball) {
  return JSON.stringify({
    name: artifact.packageName,
    "dist-tags": { latest: fixture.version },
    versions: {
      [fixture.version]: {
        name: artifact.packageName,
        version: fixture.version,
        dist: { tarball, integrity: fixture.integrity },
      },
    },
  });
}

/**
 * A local http proxy that stands in for every host that is not loopback. It records each request
 * by its absolute URL and answers with `handler`, or with a package document and tarball. A
 * CONNECT request, which an https request through the proxy sends, is tunneled to the loopback host
 * and port it names and recorded as `CONNECT host:port`.
 * @param {{ redirect?: (url: string) => string | undefined }} [options]
 */
async function startProxy({ redirect } = {}) {
  const fixture = await packed();
  /** @type {string[]} */
  const requests = [];
  const server = createHttpServer((req, res) => {
    requests.push(req.url ?? "");
    const location = redirect?.(req.url ?? "");
    if (location) {
      res.writeHead(302, { location });
      res.end();
    } else if (req.url?.endsWith(".tgz")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(fixture.tarball);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(packument(fixture, `${REMOTE_HTTP}/-/artifact.tgz`));
    }
  });
  server.on("connect", (req, socket, head) => {
    requests.push(`CONNECT ${req.url}`);
    const target = new URL(`http://${req.url}`);
    if (!["127.0.0.1", "localhost"].includes(target.hostname)) return socket.destroy();
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
}

/**
 * An npm context whose only user .npmrc names `registry` as the artifact scope's registry, `proxy`
 * as both `proxy` and `https-proxy` unless `httpsProxy` replaces the second (null leaves it out),
 * and no proxy for loopback hosts unless `proxyLoopback` is set. It cannot reach the developer's
 * own .npmrc.
 * @param {{ registry: string, proxy: string, httpsProxy?: string | null, proxyLoopback?: boolean }} options
 */
async function npmContext({ registry, proxy, httpsProxy = proxy, proxyLoopback = false }) {
  const directory = await temporaryDirectory("calavera-redirect-");
  const userconfig = join(directory, "user.npmrc");
  await writeFile(
    userconfig,
    [
      `@schalkneethling:registry=${registry}/`,
      `proxy=${proxy}/`,
      ...(httpsProxy === null ? [] : [`https-proxy=${httpsProxy}/`]),
      proxyLoopback ? "noproxy=127.0.0.1" : "noproxy=127.0.0.1,localhost",
      "",
    ].join("\n"),
  );
  return {
    cwd: directory,
    env: { npm_config_userconfig: userconfig },
    cache: join(directory, "cache"),
    destination: join(directory, "package"),
  };
}

/** @param {Promise<unknown>} promise */
function failureOf(promise) {
  return promise.then(
    () => assert.fail("Expected the request to be refused."),
    (error) => error,
  );
}

/**
 * The refusal names the package and the two protocols and quotes no other URL text.
 * @param {any} failure
 * @param {{ from: string, download: boolean, requests: number, otherHost?: boolean }} expected
 *   `requests` counts the requests the check saw, the refused one included. `otherHost` marks a
 *   lookup on a plain-http registry that was sent to another plain-http host.
 */
function assertRefusal(failure, { from, download, requests, otherHost = false }) {
  const refusal = failure.cause?.code === "EINSECUREREDIRECT" ? failure.cause : failure;
  assert.equal(failure.code, "EINSECUREREDIRECT");
  const subject = download ? "tarball download" : "package document lookup";
  assert.equal(
    refusal.message,
    otherHost
      ? `Calavera did not fetch ${artifact.packageName}: a redirect led its ${subject} from http: to http: on another host that is not loopback. ${HOST_RULE}`
      : `Calavera did not fetch ${artifact.packageName}: a redirect led its ${subject} from ${from} to http: on a host that is not loopback. ${download ? TARBALL_RULE : DOWNGRADE_RULE}`,
  );
  assert.equal(refusal.otherHost, otherHost);
  assert.equal(refusal.packageName, artifact.packageName);
  assert.equal(refusal.protocol, from);
  assert.equal(refusal.redirectProtocol, "http:");
  assert.equal(refusal.download, download);
  assert.equal(refusal.requests, requests);
  // No host the redirects named, port, or path. The rule sentence names the loopback hosts.
  assert.doesNotMatch(failure.message, /example\.test|:\d{2,}|\/-\/|%2f|artifact\.tgz/i);
}

test("a lookup redirected from https through https to http on a host that is not loopback is refused before the http request", async (t) => {
  const proxy = await startProxy();
  const second = await startServer({
    secure: true,
    host: "localhost",
    redirect: (path) => `${REMOTE_HTTP}${path}`,
    cacheable: true,
  });
  const first = await startServer({
    secure: true,
    host: "127.0.0.1",
    redirect: (path) => `${second.origin}${path}`,
    cacheable: true,
  });
  t.after(() => Promise.all([proxy.close(), first.close(), second.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  for (const run of ["first", "cached"]) {
    // The second run reuses the cache, which holds both servers' 301s. make-fetch-happen then
    // follows the stored redirects without asking either server, so the first request the check
    // sees is the http one, and the refusal still holds because the lookup started on https.
    const failure = await failureOf(
      resolveArtifactPackage({ id: artifact.id, cache: context.cache, ...context }),
    );
    assertRefusal(failure, { from: "https:", download: false, requests: run === "first" ? 3 : 1 });
    assert.deepEqual(proxy.requests, [], `${run} run sent no request to the http host`);
  }
  assert.equal(first.requests.length, 1);
  assert.equal(second.requests.length, 1);
});

test("a dist-tag lookup redirected from https to http on a host that is not loopback is refused", async (t) => {
  const proxy = await startProxy();
  const first = await startServer({
    secure: true,
    host: "127.0.0.1",
    redirect: (path) => `${REMOTE_HTTP}${path}`,
  });
  t.after(() => Promise.all([proxy.close(), first.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  const failure = await failureOf(
    resolvePackageDistTag({
      packageName: artifact.packageName,
      tag: "latest",
      cwd: context.cwd,
      env: context.env,
    }),
  );
  assertRefusal(failure, { from: "https:", download: false, requests: 2 });
  assert.deepEqual(proxy.requests, []);
});

test("a tarball download redirected from https through https to http on a host that is not loopback is refused before the http request", async (t) => {
  const proxy = await startProxy();
  const second = await startServer({
    secure: true,
    host: "localhost",
    redirect: (path) => (path.endsWith(".tgz") ? `${REMOTE_HTTP}${path}` : undefined),
  });
  const first = await startServer({
    secure: true,
    host: "127.0.0.1",
    redirect: (path) => (path.endsWith(".tgz") ? `${second.origin}${path}` : undefined),
  });
  t.after(() => Promise.all([proxy.close(), first.close(), second.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  const failure = await failureOf(
    extractArtifactPackage(resolution, context.destination, "2.2.0", context),
  );
  assertRefusal(failure, { from: "https:", download: true, requests: 3 });
  assert.deepEqual(proxy.requests, []);
  assert.deepEqual(await readdir(context.destination).catch(() => []), []);
});

test("a tarball download redirected from loopback http to http on a host that is not loopback is refused", async (t) => {
  const proxy = await startProxy();
  const first = await startServer({
    secure: false,
    host: "127.0.0.1",
    redirect: (path) => (path.endsWith(".tgz") ? `${REMOTE_HTTP}${path}` : undefined),
  });
  t.after(() => Promise.all([proxy.close(), first.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  const failure = await failureOf(
    extractArtifactPackage(resolution, context.destination, "2.2.0", context),
  );
  assertRefusal(failure, { from: "http:", download: true, requests: 2 });
  assert.deepEqual(proxy.requests, []);
});

test("a download that starts on loopback http is judged from http, even when the registry is on https", async (t) => {
  // The download's first URL is the tarball, not the registry, so the refusal reports http: as the
  // protocol it was on.
  const proxy = await startProxy();
  const tarballHost = await startServer({
    secure: false,
    host: "localhost",
    redirect: (path) => (path.endsWith(".tgz") ? `${REMOTE_HTTP}${path}` : undefined),
  });
  const registry = await startServer({
    secure: true,
    host: "127.0.0.1",
    tarballUrl: () => `${tarballHost.origin}/-/artifact.tgz`,
  });
  t.after(() => Promise.all([proxy.close(), tarballHost.close(), registry.close()]));
  const context = await npmContext({ registry: registry.origin, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  const failure = await failureOf(
    extractArtifactPackage(resolution, context.destination, "2.2.0", context),
  );
  assertRefusal(failure, { from: "http:", download: true, requests: 2 });
  assert.deepEqual(proxy.requests, []);
});

test("a lookup and a download redirected from loopback http to loopback http succeed", async (t) => {
  const proxy = await startProxy();
  const second = await startServer({ secure: false, host: "localhost" });
  const first = await startServer({
    secure: false,
    host: "127.0.0.1",
    redirect: (path) => `${second.origin}${path}`,
  });
  t.after(() => Promise.all([proxy.close(), first.close(), second.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  // The package document names a tarball on the second server, so redirect it back through the first.
  const result = await extractArtifactPackage(
    { ...resolution, resolved: `${first.origin}/-/artifact.tgz` },
    context.destination,
    "2.2.0",
    context,
  );
  assert.equal(result.manifest.id, artifact.id);
  assert.equal(first.requests.length, 2);
  assert.equal(second.requests.length, 2);
  assert.deepEqual(proxy.requests, []);
});

test("a lookup and a download redirected from https to loopback http succeed", async (t) => {
  const proxy = await startProxy();
  const loopback = await startServer({ secure: false, host: "localhost" });
  const first = await startServer({
    secure: true,
    host: "127.0.0.1",
    redirect: (path) => `${loopback.origin}${path}`,
  });
  t.after(() => Promise.all([proxy.close(), first.close(), loopback.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  const result = await extractArtifactPackage(
    { ...resolution, resolved: `${first.origin}/-/artifact.tgz` },
    context.destination,
    "2.2.0",
    context,
  );
  assert.equal(result.manifest.id, artifact.id);
  assert.equal(first.requests.length, 2);
  assert.equal(loopback.requests.length, 2);
  assert.deepEqual(proxy.requests, []);
});

test("a lookup and a download redirected from https to https succeed", async (t) => {
  const proxy = await startProxy();
  const second = await startServer({ secure: true, host: "localhost" });
  const first = await startServer({
    secure: true,
    host: "127.0.0.1",
    redirect: (path) => `${second.origin}${path}`,
  });
  t.after(() => Promise.all([proxy.close(), first.close(), second.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  assert.equal(resolution.resolved, `${second.origin}/-/artifact.tgz`);
  const result = await extractArtifactPackage(
    { ...resolution, resolved: `${first.origin}/-/artifact.tgz` },
    context.destination,
    "2.2.0",
    context,
  );
  assert.equal(result.manifest.id, artifact.id);
  assert.deepEqual(proxy.requests, []);
});

test("a user .npmrc http registry on a host that is not loopback still answers a lookup through the proxy", async (t) => {
  // A user's own .npmrc may name a plain-http registry (#1185, #1186). The lookup starts on http,
  // so no https hop was downgraded.
  const proxy = await startProxy();
  t.after(proxy.close);
  const context = await npmContext({ registry: REMOTE_HTTP, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  assert.equal(resolution.resolved, `${REMOTE_HTTP}/-/artifact.tgz`);
  assert.deepEqual(proxy.requests, [
    `${REMOTE_HTTP}/@schalkneethling%2fcalavera-skill-project-goal`,
  ]);
});

test("a lookup that starts on a user's http registry and passes through https is refused when it returns to http", async (t) => {
  const secure = await startServer({
    secure: true,
    host: "127.0.0.1",
    redirect: (path) => `http://mirror.example.test${path}`,
  });
  t.after(secure.close);
  const redirecting = await startProxy({
    redirect: (url) => (isRemote(url) ? `${secure.origin}/next` : undefined),
  });
  t.after(redirecting.close);
  const context = await npmContext({ registry: REMOTE_HTTP, proxy: redirecting.url });

  const failure = await failureOf(resolveArtifactPackage({ id: artifact.id, ...context }));
  assertRefusal(failure, { from: "https:", download: false, requests: 3 });
  assert.deepEqual(redirecting.requests, [
    `${REMOTE_HTTP}/@schalkneethling%2fcalavera-skill-project-goal`,
  ]);
  assert.equal(secure.requests.length, 1);
});

// Owner decision 1 on #1207 (2026-11-24): a plain-http registry that the rules allow may redirect
// over plain http only to its own host, as the URL parser writes host and port, or to loopback.
const SAME_HOST = [
  { form: "another path", location: `${REMOTE_HTTP}/elsewhere/document` },
  { form: "the default port written out", location: "http://REGISTRY.example.test:80/document" },
];
for (const { form, location } of SAME_HOST) {
  test(`a user's http registry may redirect a lookup to its own host, with ${form}`, async (t) => {
    const proxy = await startProxy({
      redirect: (url) => (url.includes("calavera-skill-project-goal") ? location : undefined),
    });
    t.after(proxy.close);
    const context = await npmContext({ registry: REMOTE_HTTP, proxy: proxy.url });

    const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
    assert.equal(resolution.version, (await packed()).version);
    assert.equal(proxy.requests.length, 2);
  });
}

const OTHER_HOST = [
  { form: "another host", location: "http://mirror.example.test/document" },
  { form: "another port on the same host", location: `${REMOTE_HTTP}:8080/document` },
];
for (const { form, location } of OTHER_HOST) {
  test(`a user's http registry that redirects a lookup to ${form} over http is refused`, async (t) => {
    const proxy = await startProxy({
      redirect: (url) => (url.includes("calavera-skill-project-goal") ? location : undefined),
    });
    t.after(proxy.close);
    const context = await npmContext({ registry: REMOTE_HTTP, proxy: proxy.url });

    const failure = await failureOf(resolveArtifactPackage({ id: artifact.id, ...context }));
    assertRefusal(failure, { from: "http:", download: false, requests: 2, otherHost: true });
    assert.deepEqual(proxy.requests, [
      `${REMOTE_HTTP}/@schalkneethling%2fcalavera-skill-project-goal`,
    ]);
  });
}

// The own-host rule compares every hop with the configured registry, not with the previous hop or
// the first hop the check sees: a cached 301 from the registry means the first hop the check sees
// can already be on another host.
for (const { chain, refused } of [
  { chain: [REMOTE_HTTP, "http://localhost:4873", "http://mirror.example.test"], refused: 3 },
  { chain: [REMOTE_HTTP, `${REMOTE_HTTP}/again`, "http://mirror.example.test"], refused: 3 },
  { chain: [REMOTE_HTTP, "http://127.0.0.1:4873", `${REMOTE_HTTP}/back`], refused: null },
  { chain: ["http://mirror.example.test"], refused: 1 },
]) {
  test(`the own-host rule judges ${chain.join(" -> ")} against the registry`, () => {
    const agent = redirectGuard({
      packageName: artifact.packageName,
      download: false,
      startUrl: `${REMOTE_HTTP}/`,
      agent: () => "agent",
    });
    for (const [index, url] of chain.entries()) {
      if (index + 1 === refused) {
        assert.throws(() => agent(new URL(url)), { code: "EINSECUREREDIRECT", otherHost: true });
        return;
      }
      assert.equal(agent(new URL(url)), "agent");
    }
    assert.equal(refused, null);
  });
}

// One trailing dot names the same host in DNS, so the own-host rule ignores it on either side and
// keeps the port. A loopback name with a trailing dot, such as localhost., is not a loopback host.
for (const { start, hop, otherHost } of [
  { start: `${REMOTE_HTTP}/`, hop: "http://registry.example.test./document", otherHost: null },
  { start: "http://registry.example.test./", hop: `${REMOTE_HTTP}/document`, otherHost: null },
  { start: `${REMOTE_HTTP}/`, hop: "http://registry.example.test.:8080/document", otherHost: true },
  { start: `${REMOTE_HTTP}/`, hop: "http://localhost.:4873/document", otherHost: true },
  { start: "https://registry.example.test/", hop: "http://localhost.:4873/", otherHost: false },
]) {
  test(`the own-host rule judges ${hop} after ${start}`, () => {
    const agent = redirectGuard({
      packageName: artifact.packageName,
      download: false,
      startUrl: start,
      agent: () => "agent",
    });
    if (otherHost === null) assert.equal(agent(new URL(hop)), "agent");
    else assert.throws(() => agent(new URL(hop)), { code: "EINSECUREREDIRECT", otherHost });
  });
}

test("a loopback http registry that redirects a lookup to http on a host that is not loopback is refused", async (t) => {
  const proxy = await startProxy();
  const first = await startServer({
    secure: false,
    host: "127.0.0.1",
    redirect: (path) => `${REMOTE_HTTP}${path}`,
  });
  t.after(() => Promise.all([proxy.close(), first.close()]));
  const context = await npmContext({ registry: first.origin, proxy: proxy.url });

  const failure = await failureOf(resolveArtifactPackage({ id: artifact.id, ...context }));
  assertRefusal(failure, { from: "http:", download: false, requests: 2, otherHost: true });
  assert.deepEqual(proxy.requests, []);
});

test("a user's http registry may redirect a lookup to loopback http", async (t) => {
  const loopback = await startServer({ secure: false, host: "localhost" });
  const proxy = await startProxy({
    redirect: (url) => (isRemote(url) ? `${loopback.origin}${new URL(url).pathname}` : undefined),
  });
  t.after(() => Promise.all([proxy.close(), loopback.close()]));
  const context = await npmContext({ registry: REMOTE_HTTP, proxy: proxy.url });

  const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
  assert.equal(resolution.version, (await packed()).version);
  assert.equal(loopback.requests.length, 1);
});

for (const { setting, proxies } of [
  {
    setting: "proxy alone",
    proxies: (/** @type {string} */ live) => ({ proxy: live, httpsProxy: null }),
  },
  {
    setting: "https-proxy over proxy",
    // Nothing listens on port 9, so a request sent to `proxy` fails.
    proxies: (/** @type {string} */ live) => ({ proxy: "http://127.0.0.1:9", httpsProxy: live }),
  },
]) {
  test(`an https registry behind the proxy is reached through a CONNECT tunnel, with ${setting}`, async (t) => {
    // Calavera passes its own agent for every request, so this checks that the proxy settings
    // still apply to https requests, with npm-registry-fetch's choice between them.
    const proxy = await startProxy();
    const registry = await startServer({ secure: true, host: "localhost" });
    t.after(() => Promise.all([proxy.close(), registry.close()]));
    const context = await npmContext({
      registry: registry.origin,
      ...proxies(proxy.url),
      proxyLoopback: true,
    });

    const resolution = await resolveArtifactPackage({ id: artifact.id, ...context });
    assert.equal(resolution.version, (await packed()).version);
    const port = registry.origin.split(":").at(-1);
    assert.deepEqual(proxy.requests, [`CONNECT localhost:${port}`]);
  });
}

test("requestAgent keeps an agent function the loader chose", () => {
  // The loader sets one when it must keep a proxy variable away from every request (#1186).
  const agent = () => undefined;
  assert.equal(npmConfig.requestAgent({ agent }), agent);
});

test("the agent options Calavera passes match npm-registry-fetch's defaults", () => {
  // Calavera chooses each request's agent itself (see NPM_REGISTRY_FETCH_AGENT_DEFAULTS), with
  // the options npm-registry-fetch would pass to @npmcli/agent. This fails when the installed
  // npm-registry-fetch changes them.
  const fromPacote = createRequire(createRequire(import.meta.url).resolve("pacote"));
  const defaults = fromPacote("npm-registry-fetch/lib/default-opts.js");
  assert.deepEqual(npmConfig.NPM_REGISTRY_FETCH_AGENT_DEFAULTS, {
    maxSockets: defaults.maxSockets,
    timeout: defaults.timeout,
    noProxy: defaults.noProxy,
    strictSSL: defaults.strictSSL,
  });
});

test("the dist-tag lookup stores no response, so every redirect it follows reaches the check", async (t) => {
  // resolvePackageDistTag passes pacote no cache. pacote then hands make-fetch-happen no cache path
  // for the package document (pacote lib/registry.js spreads the caller's options, and its default
  // cache folder serves only tarballs), so a cacheable 301 is asked for again on the next lookup.
  // A child process with its own HOME shows that nothing lands in npm's cache folder either.
  const target = await startServer({ secure: false, host: "127.0.0.1" });
  const first = await startServer({
    secure: false,
    host: "127.0.0.1",
    redirect: (path) => `${target.origin}${path}`,
    cacheable: true,
  });
  t.after(() => Promise.all([first.close(), target.close()]));
  const directory = await temporaryDirectory("calavera-redirect-dist-tag-cache-");
  const home = join(directory, "home");
  await mkdir(home);
  const userconfig = join(directory, "user.npmrc");
  await writeFile(userconfig, `@schalkneethling:registry=${first.origin}/\n`);
  const script = join(directory, "probe.mjs");
  const registryModule = new URL("../src/registry.js", import.meta.url).href;
  await writeFile(
    script,
    `import { resolvePackageDistTag } from ${JSON.stringify(registryModule)};
for (let run = 0; run < 2; run += 1) {
  await resolvePackageDistTag({ packageName: ${JSON.stringify(artifact.packageName)}, tag: "latest", cwd: process.env.PROBE_CWD, env: process.env });
}
`,
  );
  await execFileAsync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      npm_config_userconfig: userconfig,
      PROBE_CWD: directory,
      ...(process.env.__STRYKER_ACTIVE_MUTANT__
        ? { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ }
        : {}),
    },
  });
  assert.equal(first.requests.length, 2);
  assert.equal(target.requests.length, 2);
  assert.deepEqual(await readdir(home), []);
});

test("NOPROXY, which npm-registry-fetch reads and @npmcli/agent does not, keeps a host away from the proxy", async (t) => {
  // Calavera's NPM_REGISTRY_FETCH_AGENT_DEFAULTS reads NOPROXY when npm-config.js loads, as
  // npm-registry-fetch's default-opts.js does, so a child process starts with it set. The user
  // .npmrc names a proxy and no noproxy setting, so only the NOPROXY fallback keeps the registry on
  // 127.0.0.1 direct.
  const proxy = await startProxy();
  const registry = await startServer({ secure: false, host: "127.0.0.1" });
  t.after(() => Promise.all([proxy.close(), registry.close()]));
  const directory = await temporaryDirectory("calavera-redirect-noproxy-");
  const userconfig = join(directory, "user.npmrc");
  await writeFile(
    userconfig,
    `@schalkneethling:registry=${registry.origin}/\nproxy=${proxy.url}/\n`,
  );
  const script = join(directory, "probe.mjs");
  const registryModule = new URL("../src/registry.js", import.meta.url).href;
  await writeFile(
    script,
    `import { resolvePackageDistTag } from ${JSON.stringify(registryModule)};
const version = await resolvePackageDistTag({ packageName: ${JSON.stringify(artifact.packageName)}, tag: "latest", cwd: process.env.PROBE_CWD, env: process.env });
console.log(JSON.stringify({ version }));
`,
  );
  const { stdout } = await execFileAsync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      HOME: join(directory, "home"),
      NOPROXY: "127.0.0.1",
      npm_config_userconfig: userconfig,
      PROBE_CWD: directory,
      ...(process.env.__STRYKER_ACTIVE_MUTANT__
        ? { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ }
        : {}),
    },
  });
  assert.deepEqual(JSON.parse(stdout), { version: (await packed()).version });
  assert.deepEqual(proxy.requests, []);
  assert.equal(registry.requests.length, 1);
});

test("Calavera's agents are the ones make-fetch-happen would choose from the same options", async (t) => {
  // Each lookup goes once through pacote with the loader's options alone, where make-fetch-happen
  // chooses the agent, and once through Calavera's guarded call. @npmcli/agent caches its agents and
  // proxy agents by every option that shapes them, so equal cache keys mean equal agents. The http
  // registry is reached directly and the https one through the proxy.
  const fromMakeFetchHappen = createRequire(
    createRequire(createRequire(import.meta.url).resolve("pacote")).resolve("npm-registry-fetch"),
  );
  const ownAgent = createRequire(import.meta.url).resolve("@npmcli/agent");
  assert.equal(
    createRequire(fromMakeFetchHappen.resolve("make-fetch-happen")).resolve("@npmcli/agent"),
    ownAgent,
    "artifact-core and make-fetch-happen load the same @npmcli/agent",
  );
  const proxy = await startProxy();
  const plain = await startServer({ secure: false, host: "127.0.0.1" });
  const secure = await startServer({ secure: true, host: "localhost" });
  t.after(() => Promise.all([proxy.close(), plain.close(), secure.close()]));

  for (const registry of [plain.origin, secure.origin]) {
    const context = await npmContext({ registry, proxy: proxy.url, proxyLoopback: true });
    const keys = async (/** @type {() => Promise<unknown>} */ run) => {
      agentCache.clear();
      await run();
      return { agents: [...agentCache.agent.keys()], proxies: [...agentCache.proxy.keys()] };
    };
    const npm = await npmConfig.loadNpmRegistryOptions({
      ...context,
      scope: "@schalkneethling",
    });
    const chosen = await keys(() =>
      pacote.manifest(`${artifact.packageName}@latest`, { ...npm.requestOptions, fetchRetries: 0 }),
    );
    const guarded = await keys(() =>
      resolvePackageDistTag({
        packageName: artifact.packageName,
        tag: "latest",
        cwd: context.cwd,
        env: context.env,
      }),
    );
    assert.ok(chosen.agents.length > 0, registry);
    assert.deepEqual(guarded, chosen, registry);
  }
});
