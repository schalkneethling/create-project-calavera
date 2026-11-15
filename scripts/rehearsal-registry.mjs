// A local npm registry for the cli-experience exit rehearsal (#918). It answers for the packed
// release candidate (the CLI, its workspace dependencies, and every artifact) from local tarballs,
// so every launcher installs what will be published and artifact installs need no network. It
// forwards every other request to the public registry, and it can hold the Vite+ packages at one
// version, so `npm create vite-plus@latest` and an unversioned `vite-plus` resolve to that version.
// npm, pnpm, Yarn, Bun, and the CLI's own artifact resolver all read the registry from their
// environment, which is how the rehearsal points them here.
import { createReadStream } from "node:fs";
import { createServer } from "node:http";

import semver from "semver";

const UPSTREAM = "https://registry.npmjs.org";

/** The packages Vite+ releases together at one version; `create-vite-plus` depends on `vite-plus` exactly. */
export const VITE_PLUS_PACKAGES = ["vite-plus", "create-vite-plus"];

// A fixed publish time keeps the packument the same on every run and lets package managers that
// hold back recently published versions (pnpm's minimumReleaseAge) install the release candidate.
const LOCAL_PUBLISH_TIME = "2000-01-01T00:00:00.000Z";

/**
 * @typedef {{ name: string, version: string, path: string, integrity: string, shasum: string, manifest: Record<string, unknown> }} LocalPackage
 */

/**
 * The packument for one locally packed package: its only version is the packed one, and that
 * version is `latest` unless `advertisedLatest` names a newer one that is listed but not served.
 *
 * @param {LocalPackage} local
 * @param {string} baseUrl
 * @param {string} [advertisedLatest]
 */
export function localPackument(local, baseUrl, advertisedLatest) {
  const tarballName = `${local.name.split("/").pop()}-${local.version}.tgz`;
  const versionEntry = {
    ...local.manifest,
    name: local.name,
    version: local.version,
    dist: {
      tarball: `${baseUrl}/${local.name}/-/${tarballName}`,
      integrity: local.integrity,
      shasum: local.shasum,
    },
  };
  /** @type {Record<string, unknown>} */
  const versions = { [local.version]: versionEntry };
  /** @type {Record<string, string>} */
  const time = { [local.version]: LOCAL_PUBLISH_TIME };
  if (advertisedLatest !== undefined) {
    // Listed so a version check sees it; its tarball is the packed one, so installing it would
    // fail the integrity of a real newer release. The rehearsal never installs it.
    versions[advertisedLatest] = { ...versionEntry, version: advertisedLatest };
    time[advertisedLatest] = LOCAL_PUBLISH_TIME;
  }
  return {
    name: local.name,
    "dist-tags": { latest: advertisedLatest ?? local.version },
    versions,
    time: { created: LOCAL_PUBLISH_TIME, modified: LOCAL_PUBLISH_TIME, ...time },
  };
}

/**
 * Holds a public packument at `pin`: drops every version newer than the pin, and points `latest`,
 * and every other dist-tag that named a dropped version, at the pin.
 *
 * @param {{ "dist-tags"?: Record<string, string>, versions?: Record<string, unknown>, time?: Record<string, string> }} packument
 * @param {string} pin
 */
export function pinPackument(packument, pin) {
  const versions = packument.versions ?? {};
  if (!(pin in versions)) {
    throw new Error(`The registry has no version ${pin}; it has ${Object.keys(versions).length}.`);
  }
  const keep = Object.fromEntries(
    Object.entries(versions).filter(([version]) => !semver.gt(version, pin)),
  );
  const distTags = Object.fromEntries(
    Object.entries(packument["dist-tags"] ?? {}).map(([tag, version]) => [
      tag,
      version in keep ? version : pin,
    ]),
  );
  const time = Object.fromEntries(
    Object.entries(packument.time ?? {}).filter(
      ([key]) => key === "created" || key === "modified" || key in keep,
    ),
  );
  return { ...packument, "dist-tags": { ...distTags, latest: pin }, versions: keep, time };
}

/**
 * Splits a registry request path into the package name and, for a tarball request, its file name.
 * npm escapes the slash of a scoped name as %2f; pnpm and Yarn may not.
 *
 * @param {string} path
 * @returns {{ name: string, tarball?: string } | undefined}
 */
export function parseRegistryPath(path) {
  const decoded = decodeURIComponent(path.split("?")[0] ?? "").replace(/^\/+/, "");
  const match = /^((?:@[^/]+\/)?[^/@][^/]*)(?:\/-\/([^/]+\.tgz))?$/.exec(decoded);
  if (!match?.[1]) return undefined;
  return match[2] === undefined ? { name: match[1] } : { name: match[1], tarball: match[2] };
}

/**
 * @param {{
 *   local: Map<string, LocalPackage>,
 *   vitePlusVersion?: string,
 *   advertisedLatest?: { name: string, version: string },
 *   fetchUpstream?: typeof fetch,
 * }} options
 * @returns {Promise<{ url: string, requests: string[], close: () => Promise<void> }>}
 */
export async function startRegistry({
  local,
  vitePlusVersion,
  advertisedLatest,
  fetchUpstream = fetch,
}) {
  /** @type {string[]} */
  const requests = [];
  let baseUrl = "";

  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    requests.push(`${request.method} ${path}`);
    try {
      const parsed = parseRegistryPath(path);
      const packed = parsed ? local.get(parsed.name) : undefined;
      if (parsed && packed) {
        if (parsed.tarball !== undefined) {
          response.writeHead(200, { "content-type": "application/octet-stream" });
          createReadStream(packed.path).pipe(response);
          return;
        }
        const advertised =
          advertisedLatest?.name === parsed.name ? advertisedLatest.version : undefined;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(localPackument(packed, baseUrl, advertised)));
        return;
      }

      /** @type {Uint8Array[]} */
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetchUpstream(`${UPSTREAM}${path}`, {
        method: request.method,
        headers: {
          accept: request.headers.accept ?? "application/json",
          ...(request.headers["content-type"]
            ? { "content-type": request.headers["content-type"] }
            : {}),
        },
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      });
      const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
      const pinned =
        vitePlusVersion !== undefined &&
        upstream.ok &&
        parsed?.tarball === undefined &&
        parsed !== undefined &&
        VITE_PLUS_PACKAGES.includes(parsed.name);
      if (pinned) {
        const packument = pinPackument(await upstream.json(), vitePlusVersion);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(packument));
        return;
      }
      // fetch has already decoded the body, so content-encoding and content-length do not apply.
      response.writeHead(upstream.status, { "content-type": contentType });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`Rehearsal registry error for ${path}: ${/** @type {Error} */ (error).message}`);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The rehearsal registry did not get a TCP port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: baseUrl,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
