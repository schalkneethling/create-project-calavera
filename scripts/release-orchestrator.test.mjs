import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoverPublicPackages,
  hasPendingVersionBumps,
  isExplicitRegistryNotFound,
  packagesFromReleaseNotes,
  releaseChannel,
  releaseTag,
  validateReleaseMetadata,
} from "./release-orchestrator.mjs";
import { generatedFormatPaths, versionPackages } from "./release-version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("registry absence accepts only explicit 404 responses", () => {
  assert.equal(
    isExplicitRegistryNotFound({ status: 1, stdout: "", stderr: "npm error code E404" }),
    true,
  );
  assert.equal(
    isExplicitRegistryNotFound({ status: 1, stdout: "", stderr: "npm error code ENOTFOUND" }),
    false,
  );
  assert.equal(isExplicitRegistryNotFound({ status: 0, stdout: '"1.0.0"', stderr: "" }), false);
});

test("release channels and tags are derived from exact versions", () => {
  assert.equal(releaseChannel("2.4.0-next.1"), "next");
  assert.equal(releaseChannel("2.4.0"), "latest");
  assert.equal(
    releaseTag([{ name: "create-project-calavera", version: "2.4.0-next.1" }], "a".repeat(40)),
    "v2.4.0-next.1",
  );
  assert.equal(releaseTag([], "abcdef1234567890"), "packages-abcdef123456");
});

test("Changesets status distinguishes pending bumps from NO-package summaries", () => {
  assert.equal(
    hasPendingVersionBumps(
      "🦋  info NO packages to be bumped at patch\n🦋  info NO packages to be bumped at minor",
    ),
    false,
  );
  assert.equal(
    hasPendingVersionBumps(
      "🦋  info NO packages to be bumped at patch\n🦋  info Packages to be bumped at minor:",
    ),
    true,
  );
});

test("release metadata must identify the exact candidate transition", () => {
  const metadata = {
    tagName: "v2.4.0-next.1",
    targetCommitish: "abc123",
    isDraft: true,
    isPrerelease: true,
  };
  assert.doesNotThrow(() =>
    validateReleaseMetadata(metadata, {
      tag: "v2.4.0-next.1",
      sha: "abc123",
      draft: true,
      prerelease: true,
    }),
  );
  assert.throws(
    () =>
      validateReleaseMetadata(metadata, {
        tag: "v2.4.0-next.1",
        sha: "different",
        draft: true,
        prerelease: true,
      }),
    /does not match/,
  );
});

test("published release notes recover the exact package inventory for reruns", () => {
  const plan = {
    packages: [
      {
        name: "create-project-calavera",
        version: "2.4.0-next.0",
        published: true,
      },
      {
        name: "@schalkneethling/calavera-artifact-core",
        version: "0.3.0-next.0",
        published: true,
      },
      {
        name: "@schalkneethling/unrelated",
        version: "1.0.0",
        published: true,
      },
    ],
  };
  assert.deepEqual(
    packagesFromReleaseNotes(
      plan,
      "Packages:\n- create-project-calavera@2.4.0-next.0\n- @schalkneethling/calavera-artifact-core@0.3.0-next.0",
    ).map(({ name, published }) => ({ name, published })),
    [
      { name: "create-project-calavera", published: false },
      { name: "@schalkneethling/calavera-artifact-core", published: false },
    ],
  );
});

test("public release packages are discovered from workspace metadata", async () => {
  const packages = await discoverPublicPackages();
  assert.ok(packages.some(({ name }) => name === "create-project-calavera"));
  assert.ok(
    packages.some(({ name }) => name === "@schalkneethling/calavera-skill-release-with-confidence"),
  );
  assert.equal(
    packages.some(({ name }) => name === "@calavera/menu-bar"),
    false,
  );
});

test("version formatting is limited to changed generated documents", () => {
  assert.deepEqual(
    generatedFormatPaths([
      ".changeset/pre.json",
      "packages/cli/package.json",
      "packages/cli/CHANGELOG.md",
      "packages/cli/src/index.js",
      ".changeset/pre.json",
    ]),
    [".changeset/pre.json", "packages/cli/CHANGELOG.md", "packages/cli/package.json"],
  );
});

test("version generation formats one-item prerelease state deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-version-fixture-"));
  await mkdir(join(directory, ".changeset"));
  await mkdir(join(directory, "packages", "fixture"), { recursive: true });
  await mkdir(join(directory, "apps", "private"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "release-fixture",
        private: true,
        workspaces: ["packages/*", "apps/*"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(directory, ".oxfmtrc.json"), "{}\n");
  await writeFile(
    join(directory, ".changeset", "config.json"),
    `${JSON.stringify(
      {
        $schema: "https://unpkg.com/@changesets/config@3.1.1/schema.json",
        changelog: false,
        commit: false,
        fixed: [],
        linked: [],
        access: "restricted",
        baseBranch: "main",
        updateInternalDependencies: "patch",
        ignore: ["private-app"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, ".changeset", "pre.json"),
    `${JSON.stringify(
      {
        mode: "pre",
        tag: "next",
        initialVersions: {
          "fixture-package": "1.0.0",
        },
        changesets: [],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, ".changeset", "one-change.md"),
    `---\n"fixture-package": minor\n---\n\nAdd a fixture feature.\n`,
  );
  await writeFile(
    join(directory, "packages", "fixture", "package.json"),
    `${JSON.stringify({ name: "fixture-package", version: "1.0.0" }, null, 2)}\n`,
  );
  const privateManifest = `${JSON.stringify(
    { name: "private-app", version: "0.1.0", private: true },
    null,
    2,
  )}\n`;
  await writeFile(join(directory, "apps", "private", "package.json"), privateManifest);

  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Calavera Test",
      "-c",
      "user.email=calavera@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: directory },
  );

  const options = {
    rootDir: directory,
    changesetBin: join(root, "node_modules", ".bin", "changeset"),
    formatterBin: join(root, "node_modules", ".bin", "oxfmt"),
  };
  versionPackages(options);

  const preState = await readFile(join(directory, ".changeset", "pre.json"), "utf8");
  const packageManifest = JSON.parse(
    await readFile(join(directory, "packages", "fixture", "package.json"), "utf8"),
  );
  assert.match(preState, /"changesets": \["one-change"\]/);
  assert.equal(packageManifest.version, "1.1.0-next.0");
  assert.equal(
    await readFile(join(directory, "apps", "private", "package.json"), "utf8"),
    privateManifest,
  );

  versionPackages(options);
  assert.equal(await readFile(join(directory, ".changeset", "pre.json"), "utf8"), preState);
});
