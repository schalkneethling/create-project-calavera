// Stands in for the npm registry only: it answers with the workspace artifact tarballs that
// scripts/release-integration.test.mjs packs, named by CALAVERA_PACKED_ARTIFACTS (a JSON object
// keyed by artifact ID). The real extractArtifactPackage then verifies integrity, package identity,
// the manifest, compatibility with the workspace CLI version, and the payload.
import { artifactForId } from "@schalkneethling/calavera-artifact-core";

export * from "@schalkneethling/calavera-artifact-core/registry";

/** @param {{ id: string, tag?: "latest" | "next", version?: string, cache: string }} request */
export async function resolveArtifactPackage(request) {
  const artifact = artifactForId(request.id);
  const packed = JSON.parse(process.env.CALAVERA_PACKED_ARTIFACTS ?? "{}")[request.id];
  if (!artifact || !packed) throw new Error(`No packed workspace artifact for ${request.id}.`);
  // The real resolver requests artifact.packageName from npm, so a package.json whose name drifts
  // from the catalog would fail there; the fixture must not paper over that.
  if (packed.packageName !== artifact.packageName) {
    throw new Error(`${request.id} package.json name must match the catalog package name.`);
  }
  return {
    artifact,
    packageName: packed.packageName,
    version: request.version ?? packed.version,
    resolved: packed.path,
    integrity: packed.integrity,
    tag: request.tag ?? "latest",
    cache: request.cache,
    offline: false,
  };
}
