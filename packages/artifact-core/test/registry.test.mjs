import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { artifactForId } from "../src/catalog.js";
import { extractArtifactPackage, hashArtifactPayload } from "../src/registry.js";

const packageRoot = fileURLToPath(new URL("../../artifacts/skill-project-goal/", import.meta.url));
const artifact = artifactForId("skill-project-goal");
const execFileAsync = promisify(execFile);

async function packFixture(directory) {
  await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: packageRoot });
  const name = (await readdir(directory)).find((entry) => entry.endsWith(".tgz"));
  if (!name) throw new Error("Fixture package did not produce a tarball.");
  const path = join(directory, name);
  const tarball = await readFile(path);
  return {
    path,
    tarball,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}

test("verified extraction checks package identity, manifest compatibility, and payload hash", async () => {
  const destination = await mkdtemp(join(tmpdir(), "calavera-registry-extract-"));
  const packed = await packFixture(destination);
  const result = await extractArtifactPackage(
    {
      artifact,
      packageName: artifact.packageName,
      version: artifact.version,
      resolved: packed.path,
      integrity: packed.integrity,
      tag: "latest",
      cache: join(destination, "cache"),
      offline: false,
    },
    join(destination, "package"),
    "2.2.0",
  );
  assert.equal(result.manifest.id, "skill-project-goal");
  assert.match(result.payloadHash, /^[a-f0-9]{64}$/);

  await assert.rejects(
    () =>
      extractArtifactPackage(
        {
          artifact,
          packageName: artifact.packageName,
          version: artifact.version,
          resolved: packed.path,
          integrity: packed.integrity,
          tag: "latest",
          cache: join(destination, "cache"),
          offline: false,
        },
        join(destination, "incompatible"),
        "4.0.0",
      ),
    /not compatible/,
  );
});

test("verified extraction rejects a tarball that fails npm integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-registry-integrity-"));
  const packed = await packFixture(directory);
  const tarballPath = join(directory, "corrupted.tgz");
  await writeFile(tarballPath, packed.tarball);

  await assert.rejects(
    () =>
      extractArtifactPackage(
        {
          artifact,
          packageName: artifact.packageName,
          version: artifact.version,
          resolved: tarballPath,
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          tag: "latest",
          cache: join(directory, "cache"),
          offline: false,
        },
        join(directory, "package"),
        "2.2.0",
      ),
    /integrity|checksum/i,
  );
});

test("payload hashes include empty directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-payload-hash-"));
  await writeFile(join(directory, "payload.txt"), "payload\n");
  const initialHash = await hashArtifactPayload(directory);

  await mkdir(join(directory, "empty"));
  const withEmptyDirectory = await hashArtifactPayload(directory);
  assert.notEqual(withEmptyDirectory, initialHash);

  await rm(join(directory, "empty"), { recursive: true });
  assert.equal(await hashArtifactPayload(directory), initialHash);
});
