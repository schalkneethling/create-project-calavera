// @ts-check
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import pacote from "pacote";
import semver from "semver";

import { artifactForId } from "./catalog.js";

const TAGS = new Set(["latest", "next"]);

/** @param {{ id: string, tag?: string, version?: string, cache: string, offline?: boolean }} request */
export async function resolveArtifactPackage(request) {
  const artifact = artifactForId(request.id);
  if (!artifact) throw new Error(`Unknown Calavera artifact: ${request.id}.`);
  const tag = request.tag ?? "latest";
  if (!TAGS.has(tag)) throw new Error("Artifact release tag must be latest or next.");
  if (request.version && !semver.valid(request.version)) {
    throw new Error(`Artifact version must be exact semver: ${request.version}.`);
  }

  const manifest = await pacote.manifest(`${artifact.packageName}@${request.version ?? tag}`, {
    cache: request.cache,
    offline: request.offline,
    fullMetadata: true,
  });
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
  };
}

/**
 * @param {{ artifact: { id: string, type: string, packageName: string }, packageName: string, version: string, resolved: string, integrity?: string, tag: string, cache: string, offline: boolean }} resolution
 * @param {string} destination
 * @param {string} cliVersion
 */
export async function extractArtifactPackage(resolution, destination, cliVersion) {
  await pacote.extract(resolution.resolved, destination, {
    cache: resolution.cache,
    integrity: resolution.integrity,
    offline: resolution.offline,
  });

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
  if (typeof compatibility !== "string" || !semver.satisfies(cliVersion, compatibility)) {
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
  for (const file of await payloadFiles(path)) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(path, file)))
      .update("\0");
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
    if (entry.isDirectory()) files.push(...(await payloadFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}
