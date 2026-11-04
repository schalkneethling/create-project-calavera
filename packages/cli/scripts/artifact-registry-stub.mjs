// A registry stand-in for tests that apply artifacts which are not locked yet. It serves the
// workspace payload of each artifact, so a test installs exactly what this repository ships.
import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { hashArtifactPayload } from "@schalkneethling/calavera-artifact-core/registry";

const artifactPackagesRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));

/**
 * A registry stand-in that serves the workspace payload of each artifact at the version in
 * `releases`, and records every resolve request.
 *
 * @param {Map<string, string>} releases
 * @param {{ failFor?: string, error?: Error, registry?: { origin: string, source: string }, warnings?: string[] }} [options]
 */
export function stubRegistry(releases, options = {}) {
  /** @type {{ id: string, version?: string }[]} */
  const requests = [];
  return {
    requests,
    resolve: async (
      /** @type {{ id: string, tag?: string, version?: string, cache: string }} */ request,
    ) => {
      requests.push({ id: request.id, version: request.version });
      if (request.id === options.failFor) throw options.error;
      const artifact = artifactForId(request.id);
      assert.ok(artifact, `Unknown artifact ${request.id}`);
      const version = request.version ?? releases.get(request.id);
      assert.ok(version, `No release for ${request.id}`);
      return {
        artifact,
        packageName: artifact.packageName,
        version,
        resolved: `https://registry.example/${request.id}-${version}.tgz`,
        integrity: `sha512-${"a".repeat(86)}==`,
        tag: request.tag ?? "latest",
        cache: request.cache,
        offline: false,
        ...(options.registry ? { registry: options.registry } : {}),
        ...(options.warnings ? { warnings: options.warnings } : {}),
      };
    },
    extract: async (
      /** @type {{ artifact: { id: string } }} */ resolution,
      /** @type {string} */ destination,
    ) => {
      const artifact = artifactForId(resolution.artifact.id);
      assert.ok(artifact);
      const payloadPath = join(destination, artifact.payload);
      await mkdir(dirname(payloadPath), { recursive: true });
      await cp(join(artifactPackagesRoot, artifact.id, artifact.payload), payloadPath, {
        recursive: true,
      });
      return {
        manifest: { type: artifact.type, payload: artifact.payload },
        payloadPath,
        payloadHash: await hashArtifactPayload(payloadPath),
      };
    },
  };
}
