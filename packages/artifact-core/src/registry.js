// @ts-check
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import pacote from "pacote";
import semver from "semver";

import { artifactForId } from "./catalog.js";
import { loadNpmRegistryOptions, pacoteTarballUrl, requestAgent } from "./npm-config.js";
import { redirectGuard } from "./redirect-guard.js";
import { assertTarballUrl, withTarballRefusal } from "./tarball-url.js";

const TAGS = new Set(["latest", "next"]);

/**
 * Registry and proxy settings come from the user and project .npmrc files and `npm_config_*`
 * variables, or the Yarn and Bun settings; see `loadNpmRegistryOptions`. No credential is sent. `cwd` (default: the current directory) holds the
 * project .npmrc, unless npm started Calavera: the project .npmrc is then the one npm read at
 * `npm_config_local_prefix`. `env` (default: the process environment) holds the variables.
 * `signal` lets the caller hold the lookup to a deadline (#1138): pacote passes it through to
 * npm-registry-fetch, and aborting it ends the request with a FETCH_ABORTED error.
 * `beforeLookup` receives the registry the lookup will ask, with its `url` (the registry URL,
 * path included, without user information), after the npm configuration is read and before any
 * request is sent. An error it throws ends the lookup with that error, unchanged,
 * and no request is sent, so a caller can skip a registry it already knows does not answer.
 * @param {{ id: string, tag?: string, version?: string, cache: string, offline?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, beforeLookup?: (registry: import("./npm-config.js").EffectiveRegistry & { url: string }) => void }} request
 */
export async function resolveArtifactPackage(request) {
  const artifact = artifactForId(request.id);
  if (!artifact) throw new Error(`Unknown Calavera artifact: ${request.id}.`);
  const tag = request.tag ?? "latest";
  if (!TAGS.has(tag)) throw new Error("Artifact release tag must be latest or next.");
  if (request.version && !semver.valid(request.version)) {
    throw new Error(`Artifact version must be exact semver: ${request.version}.`);
  }

  const npm = await loadNpmRegistryOptions({
    cwd: request.cwd,
    env: request.env,
    scope: packageScope(artifact),
  });
  request.beforeLookup?.({ ...npm.registry, url: npm.registryUrl });
  const manifest = await withNpmDiagnostics(npm, () =>
    withAuthFailure(npm, { subject: artifact.packageName, download: false }, () =>
      withRegistryCode(artifact.packageName, () =>
        pacote.manifest(`${artifact.packageName}@${request.version ?? tag}`, {
          ...guardedRequestOptions(npm, { packageName: artifact.packageName, download: false }),
          cache: request.cache,
          offline: request.offline,
          fullMetadata: true,
          signal: request.signal,
        }),
      ),
    ),
  );
  if (manifest.name !== artifact.packageName || !semver.valid(manifest.version)) {
    throw new Error(`Resolved package identity mismatch for ${artifact.packageName}.`);
  }
  if (!manifest.dist?.tarball || !manifest.dist.integrity) {
    throw new Error(`Registry metadata for ${artifact.packageName} is missing tarball integrity.`);
  }

  return {
    artifact,
    packageName: artifact.packageName,
    version: manifest.version,
    resolved: manifest.dist.tarball,
    integrity: String(manifest.dist.integrity),
    tag,
    cache: request.cache,
    offline: request.offline ?? false,
    registry: npm.registry,
    warnings: npm.warnings,
    // The package's own `repository` metadata, as published, or null when it has none. Calavera
    // derives a release-notes link from it.
    repository: /** @type {unknown} */ (manifest.repository ?? null),
  };
}

/**
 * The version a dist-tag of a package names, asked of the registry the npm configuration selects,
 * without credentials (ADR-0019 Decision 3, ADR-0021). It reads the abbreviated package document, which
 * lists the dist-tags, and passes no `cache`, so it writes nothing. `fetchRetries: 0` and `signal`
 * let the caller hold the request to a deadline: pacote passes both through to npm-registry-fetch.
 * @param {{ packageName: string, tag: string, cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} request
 * @returns {Promise<string>}
 */
export async function resolvePackageDistTag({ packageName, tag, cwd, env, signal }) {
  const npm = await loadNpmRegistryOptions({ cwd, env, scope: packageScope({ packageName }) });
  const manifest = await withNpmDiagnostics(npm, () =>
    withAuthFailure(npm, { subject: packageName, download: false }, () =>
      pacote.manifest(`${packageName}@${tag}`, {
        ...guardedRequestOptions(npm, { packageName, download: false }),
        fetchRetries: 0,
        signal,
      }),
    ),
  );
  if (manifest.name !== packageName || !semver.valid(manifest.version)) {
    throw new Error(`The registry named no valid version for ${packageName}@${tag}.`);
  }
  return manifest.version;
}

/**
 * @param {{ artifact: { id: string, type: string, packageName: string }, packageName: string, version: string, resolved: string, integrity?: string, tag: string, cache: string, offline: boolean }} resolution
 * @param {string} destination
 * @param {string} cliVersion
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [npmContext] Where to read npm configuration; see resolveArtifactPackage.
 */
export async function extractArtifactPackage(resolution, destination, cliVersion, npmContext) {
  const npm = await loadNpmRegistryOptions({
    cwd: npmContext?.cwd,
    env: npmContext?.env,
    scope: packageScope(resolution.artifact),
  });
  // pacote moves a registry.npmjs.org tarball onto its `registry` option (see pacoteTarballUrl),
  // so the artifact scope's registry, which the package document came from, is passed as that
  // option: the lookup and the download then use the same registry (ADR-0021 Decision 4). The
  // tarball URL check judges that same rewritten URL (#1194).
  const tarballUrl = pacoteTarballUrl(resolution.resolved, npm.registryUrl);
  assertTarballUrl(resolution.packageName, resolution.resolved, tarballUrl);
  await withTarballRefusal(resolution.packageName, resolution.resolved, () =>
    withNpmDiagnostics(npm, () =>
      withAuthFailure(
        npm,
        { subject: `${resolution.packageName}@${resolution.version}`, download: true },
        () =>
          pacote.extract(resolution.resolved, destination, {
            ...guardedRequestOptions(npm, {
              packageName: resolution.packageName,
              download: true,
              startUrl: tarballUrl,
            }),
            registry: npm.registryUrl,
            cache: resolution.cache,
            integrity: resolution.integrity,
            offline: resolution.offline,
            // An https URL on a git host, such as https://github.com/owner/repo, passes
            // assertTarballUrl, but npm-package-arg reads it as a git repository.
            allowGit: "none",
          }),
      ),
    ),
  );

  const packageJson = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(destination, "calavera-artifact.json"), "utf8"));
  if (packageJson.name !== resolution.packageName || packageJson.version !== resolution.version) {
    throw new Error("Extracted package identity does not match registry metadata.");
  }

  validateArtifactManifest(manifest, resolution.artifact, cliVersion);
  const payloadPath = safePayloadPath(destination, manifest.payload);
  const payloadStats = await stat(payloadPath);
  if ((manifest.type === "agent") !== payloadStats.isFile()) {
    throw new Error(`Artifact payload kind does not match manifest type ${manifest.type}.`);
  }

  return { manifest, payloadPath, payloadHash: await hashArtifactPayload(payloadPath) };
}

/**
 * The npm request options for one pacote call, with an agent that refuses a redirect to plain http
 * on a host that is not loopback (#1207); see redirectGuard. Every pacote call passes its options
 * through here, so no lookup or download follows such a redirect. `startUrl` is the first URL
 * requested: the tarball URL for a download, and the registry for a lookup.
 * @param {{ requestOptions: Record<string, unknown>, registryUrl: string }} npm
 * @param {{ packageName: string, download: boolean, startUrl?: string }} request
 * @returns {Record<string, unknown>}
 */
function guardedRequestOptions(npm, { packageName, download, startUrl = npm.registryUrl }) {
  return {
    ...npm.requestOptions,
    agent: redirectGuard({
      packageName,
      download,
      startUrl,
      agent: requestAgent(npm.requestOptions),
    }),
  };
}

/** @param {{ packageName: string }} artifact The npm scope of the package, such as @schalkneethling. */
function packageScope({ packageName }) {
  return packageName.startsWith("@") ? packageName.slice(0, packageName.indexOf("/")) : undefined;
}

/**
 * Gives a code to a lookup failure that has none. npm's registry, network, and cache errors carry a
 * code, but npm-pick-manifest throws an uncoded TypeError when the registry answers with a package
 * document it cannot read, such as `null`. Without a code, a caller cannot tell that failure from
 * Calavera's own errors, so it becomes EBADPACKUMENT, with the original error as `cause` (#993).
 * @template T
 * @param {string} packageName
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withRegistryCode(packageName, run) {
  try {
    return await run();
  } catch (error) {
    if (typeof (/** @type {{ code?: unknown }} */ (error)?.code) === "string") throw error;
    throw Object.assign(
      new Error(
        `The registry returned a package document for ${packageName} that Calavera could not read.`,
        { cause: error },
      ),
      { code: "EBADPACKUMENT" },
    );
  }
}

/**
 * @typedef {{ origin: string, source: string, setting: string | null }} RegistryReport
 */

const AUTH_STATUS = new Set([401, 403]);
// npm-registry-fetch's HTTP errors carry the request method; only a plain method name is kept.
const METHOD = /^[A-Za-z]{1,16}$/;

/**
 * Replaces a 401 or 403 answer with an error that names the origin that answered and says that
 * Calavera sends no credentials (ADR-0021 Decision 3). npm-registry-fetch sets `uri` to the final
 * URL after redirects; only its origin is kept, because a path or query can carry a token. The
 * original error, whose message holds the URL and the registry's own text, is dropped. Its cause
 * keeps only the method, `code`, `statusCode`, and origin, and is marked `debugOnly`, so the CLI
 * prints it only with CALAVERA_DEBUG. The error keeps `code` (E401, E403, EOTP, or EAUTHIP) and
 * `statusCode`, and gains `origin`, and the configured registry's `setting`, `layer`, and
 * `registryOrigin`, so the update check can tell the registry from a host it redirected to.
 * @template T
 * @param {{ registry: RegistryReport }} npm
 * @param {{ subject: string, download: boolean }} request What was asked for, and whether it was a download.
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withAuthFailure({ registry }, { subject, download }, run) {
  try {
    return await run();
  } catch (error) {
    const fields =
      /** @type {{ statusCode?: unknown, code?: unknown, uri?: unknown, method?: unknown }} */ (
        error ?? {}
      );
    if (!(error instanceof Error) || !AUTH_STATUS.has(/** @type {number} */ (fields.statusCode))) {
      throw error;
    }
    const statusCode = /** @type {number} */ (fields.statusCode);
    const code = typeof fields.code === "string" ? fields.code : `E${statusCode}`;
    const origin = httpOrigin(fields.uri) ?? registry.origin;
    const configured = registry.setting
      ? `The registry ${registry.origin}, from ${registry.setting} in the ${registry.source},`
      : `The default registry ${registry.origin}`;
    let lines;
    if (origin === registry.origin) {
      const remedy = registry.setting
        ? `point ${registry.setting} in the ${registry.source} at a registry that serves Calavera's packages without authentication, such as https://registry.npmjs.org/`
        : "configure a registry that serves Calavera's packages without authentication";
      lines = [
        `${registry.setting ? "The registry" : "The default registry"} ${origin} answered ${statusCode} for ${subject}.`,
        `Calavera sends no credentials to any registry. If this registry requires authentication, Calavera cannot use it: ${remedy}.`,
      ];
    } else {
      const host = download ? "tarball host" : "host";
      const change = registry.setting ? "point that setting at" : "configure";
      lines = [
        `The ${host} ${origin} answered ${statusCode} for ${subject}.`,
        `Calavera sends no credentials to any registry or ${host}. ${configured} ${download ? "named this download" : "sent this request there"}. If the host requires authentication, ${change} a registry ${download ? "whose packages download" : "that serves Calavera's packages"} without authentication.`,
      ];
    }
    const method =
      typeof fields.method === "string" && METHOD.test(fields.method)
        ? fields.method.toUpperCase()
        : undefined;
    const cause = Object.assign(
      new Error(`${method ? `${method} ` : ""}${origin} answered ${statusCode} (${code}).`),
      { code, statusCode, origin, debugOnly: true },
    );
    throw Object.assign(new Error(lines.join("\n"), { cause }), {
      code,
      statusCode,
      origin,
      setting: registry.setting,
      layer: registry.source,
      registryOrigin: registry.origin,
    });
  }
}

/**
 * The origin (protocol, host, and port) of an http or https URL, or undefined.
 * @param {unknown} url
 */
function httpOrigin(url) {
  if (typeof url !== "string" || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return /^https?:$/.test(parsed.protocol) ? parsed.origin : undefined;
}

/**
 * Adds what the loader ignored to a registry failure, so an ignored setting or unset variable is
 * visible. The original error stays as `cause`, and its `code`, `statusCode`, minipass-fetch's
 * `type` (the kind of a FETCH_ERROR, such as invalid-json), and the `origin`, `setting`, `layer`,
 * and `registryOrigin` of an authentication failure are kept. The notes are also
 * kept as `npmDiagnostics` and `unsetVariables`, so a caller that withholds the registry's own
 * message can still name them (#993); like the loader's notes, they never contain a value.
 * @template T
 * @param {{ diagnostics: string[], unsetVariables: string[] }} npm
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withNpmDiagnostics(npm, run) {
  try {
    return await run();
  } catch (error) {
    if (npm.diagnostics.length === 0 || !(error instanceof Error)) throw error;
    const hint =
      npm.unsetVariables.length > 0
        ? ` Unset variables: ${npm.unsetVariables.join(", ")}. MCP clients often pass a minimal environment, so a variable set in your shell may be missing here.`
        : "";
    throw Object.assign(
      new Error(
        `${error.message} Calavera ignored npm configuration that may explain this: ${npm.diagnostics.join(" ")}${hint}`,
        { cause: error },
      ),
      {
        code: /** @type {NodeJS.ErrnoException} */ (error).code,
        statusCode: /** @type {{ statusCode?: number }} */ (error).statusCode,
        type: /** @type {{ type?: unknown }} */ (error).type,
        origin: /** @type {{ origin?: unknown }} */ (error).origin,
        setting: /** @type {{ setting?: unknown }} */ (error).setting,
        layer: /** @type {{ layer?: unknown }} */ (error).layer,
        registryOrigin: /** @type {{ registryOrigin?: unknown }} */ (error).registryOrigin,
        npmDiagnostics: npm.diagnostics,
        unsetVariables: npm.unsetVariables,
      },
    );
  }
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {{ id: string, type: string, packageName: string }} artifact
 * @param {string} cliVersion
 */
function validateArtifactManifest(manifest, artifact, cliVersion) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== artifact.id ||
    manifest.type !== artifact.type ||
    typeof manifest.payload !== "string" ||
    !manifest.payload ||
    !manifest.compatibility ||
    typeof manifest.compatibility !== "object"
  ) {
    throw new Error(`Invalid artifact manifest for ${artifact.packageName}.`);
  }
  const compatibility = /** @type {Record<string, unknown>} */ (manifest.compatibility).calavera;
  if (
    typeof compatibility !== "string" ||
    !semver.satisfies(cliVersion, compatibility, { includePrerelease: true })
  ) {
    throw new Error(
      `${artifact.packageName} is not compatible with create-project-calavera ${cliVersion}.`,
    );
  }
}

/** @param {string} root @param {string} payload */
function safePayloadPath(root, payload) {
  const payloadPath = resolve(root, payload);
  const relativePath = relative(root, payloadPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Artifact payload must stay inside its package.");
  }
  return payloadPath;
}

/** @param {string} path */
export async function hashArtifactPayload(path) {
  const payloadStats = await stat(path);
  const hash = createHash("sha256");
  if (payloadStats.isFile()) {
    hash.update(await readFile(path));
    return hash.digest("hex");
  }
  for (const entry of await payloadFiles(path)) {
    hash.update(entry).update("\0");
    if (!entry.endsWith("/")) {
      hash.update(await readFile(join(path, entry))).update("\0");
    }
  }
  return hash.digest("hex");
}

/**
 * @param {string} root
 * @param {string} [directory]
 * @returns {Promise<string[]>}
 */
async function payloadFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(`${relative(root, path)}/`);
      files.push(...(await payloadFiles(root, path)));
    } else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}
