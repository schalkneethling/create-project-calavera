import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import semver from "semver";

const artifactPackagesRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));
const cliManifestPath = fileURLToPath(new URL("../../cli/package.json", import.meta.url));

test("every artifact compatibility range admits the workspace create-project-calavera version", async () => {
  const { version: cliVersion } = JSON.parse(await readFile(cliManifestPath, "utf8"));
  const entries = await readdir(artifactPackagesRoot, { withFileTypes: true });
  const artifactIds = entries.filter((entry) => entry.isDirectory()).map(({ name }) => name);
  assert.ok(artifactIds.length > 0);

  const excluded = [];
  for (const id of artifactIds) {
    const manifest = JSON.parse(
      await readFile(join(artifactPackagesRoot, id, "calavera-artifact.json"), "utf8"),
    );
    const range = manifest.compatibility.calavera;
    assert.ok(semver.validRange(range), `${id} declares an invalid range: ${range}`);
    // Same options as validateArtifactManifest in src/registry.js, which rejects the install.
    if (!semver.satisfies(cliVersion, range, { includePrerelease: true })) {
      excluded.push(`${id} (${range})`);
    }
  }
  assert.deepEqual(
    excluded,
    [],
    `These artifacts would refuse to install on create-project-calavera ${cliVersion}; widen their compatibility.calavera range.`,
  );
});
