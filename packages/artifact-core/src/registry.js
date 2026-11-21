// @ts-check
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import pacote from "pacote";
import semver from "semver";

import { artifactForId } from "./catalog.js";
import { loadNpmRegistryOptions } from "./npm-config.js";

const TAGS = new Set(["latest", "next"]);

/**
 * Registry and auth settings come from the user and project .npmrc files and `npm_config_*`
 * variables; see `loadNpmRegistryOptions`. `cwd` (default: the current directory) holds the
 * project .npmrc, and `env` (default: the process environment) holds the variables.
 * @param {{ id: string, tag?: string, version?: string, cache: string, offline?: boolean, cwd?: string, env?: NodeJS.ProcessEnv }} request
 */
export async function resolveArtifactPackage(request) {
  const artifact = artifactForId(request.id);
  if (!artifact) throw new Error(`Unknown Calavera artifact: ${request.id}.`);
  const tag = request.tag ?? "latest";
  if (!TAGS.has(tag)) throw new Error("Artifact release tag must be latest or next.");
  if (request.version && !semver.valid(request.version)) {
    throw new Error(`Artifact version must be exact semver: ${request.version}.`);
  }

  const npm = await loadNpmRegistryOptions({ ...request, scope: packageScope(artifact) });
  const manifest = await withNpmDiagnostics(npm, () =>
    pacote.manifest(`${artifact.packageName}@${request.version ?? tag}`, {
      ...npm.options,
      cache: request.cache,
      offline: request.offline,
      fullMetadata: true,
    }),
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
 * with its credentials (ADR-0019 Decision 3). It reads the abbreviated package document, which
 * lists the dist-tags, and passes no `cache`, so it writes nothing. `fetchRetries: 0` and `signal`
 * let the caller hold the request to a deadline: pacote passes both through to npm-registry-fetch.
 * @param {{ packageName: string, tag: string, cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} request
 * @returns {Promise<string>}
 */
export async function resolvePackageDistTag({ packageName, tag, cwd, env, signal }) {
  const npm = await loadNpmRegistryOptions({
    cwd,
    env,
    scope: packageScope({ packageName }),
  });
  const manifest = await withNpmDiagnostics(npm, () =>
    pacote.manifest(`${packageName}@${tag}`, { ...npm.options, fetchRetries: 0, signal }),
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
    ...npmContext,
    scope: packageScope(resolution.artifact),
  });
  await withNpmDiagnostics(npm, () =>
    pacote.extract(resolution.resolved, destination, {
      ...npm.options,
      cache: resolution.cache,
      integrity: resolution.integrity,
      offline: resolution.offline,
    }),
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

/** @param {{ packageName: string }} artifact The npm scope of the package, such as @schalkneethling. */
function packageScope({ packageName }) {
  return packageName.startsWith("@") ? packageName.slice(0, packageName.indexOf("/")) : undefined;
}

/**
 * Adds what the loader ignored to a registry failure, so a missing token or variable is visible.
 * The original error stays as `cause`, and its `code` and `statusCode` are kept. The notes are also
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
