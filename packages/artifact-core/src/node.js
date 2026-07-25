// @ts-check
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { artifactForId, artifactForLegacyPath } from "./catalog.js";

/** @param {string} idOrLegacyPath */
export function artifactPayloadPath(idOrLegacyPath) {
  const artifact = artifactForId(idOrLegacyPath) ?? artifactForLegacyPath(idOrLegacyPath);
  if (!artifact) {
    throw new Error(`Unknown Calavera artifact: ${idOrLegacyPath}.`);
  }

  const manifestUrl = import.meta.resolve(artifact.packageName);
  return join(dirname(fileURLToPath(manifestUrl)), artifact.payload);
}
