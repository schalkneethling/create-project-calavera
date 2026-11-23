// Local registries for the update-check deadline tests (#1138). The silent registry accepts every
// connection and request and never answers, so a test can show that a registry lookup gives up at
// its deadline instead of waiting for npm's own five-minute timeout. The answering registry serves
// package documents, so a test can show that a registry that answers is still checked. Neither
// needs the network.
import { createServer } from "node:http";

/**
 * Starts the silent registry on a free local port. `requests` lists each request path it saw.
 * `closed()` settles once every connection a client opened has closed, which shows that the
 * client ended its request rather than leaving it open. Disposing it destroys any connection that
 * is still open and stops the server.
 */
export async function silentRegistry() {
  /** @type {string[]} */
  const requests = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  /** @type {Promise<void>[]} */
  const closings = [];
  const server = createServer((request) => {
    // Never answers: the request stays open until the client ends it.
    requests.push(request.url ?? "");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closings.push(
      new Promise((done) => {
        socket.on("close", () => {
          sockets.delete(socket);
          done();
        });
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    requests,
    url: `http://127.0.0.1:${port}/`,
    /** How many connections the server has accepted so far. */
    connections: () => closings.length,
    closed: () => Promise.all(closings).then(() => undefined),
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(() => done(undefined)));
    },
  };
}

/**
 * Starts a local registry that answers each package document request for `versions`, a map of
 * package name to its `latest` version, and answers 404 for any other package. `requests` lists
 * each request path it saw.
 *
 * @param {Map<string, string>} versions
 */
export async function answeringRegistry(versions) {
  /** @type {string[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const name = decodeURIComponent((request.url ?? "").slice(1));
    const version = versions.get(name);
    if (!version) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name,
            version,
            dist: {
              tarball: `http://127.0.0.1:${port}/-/package.tgz`,
              integrity: `sha512-${"a".repeat(86)}==`,
            },
          },
        },
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    requests,
    url: `http://127.0.0.1:${port}/`,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(() => done(undefined)));
    },
  };
}
