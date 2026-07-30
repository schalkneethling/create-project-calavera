import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoverPublicPackages,
  hasExpectedTrust,
  hasPendingVersionBumps,
  isExplicitRegistryNotFound,
  packagesFromReleaseNotes,
  parseOptions,
  releaseChannel,
  releaseTag,
  validateReleaseMetadata,
  waitForRun,
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
  assert.equal(releaseChannel("1.0.0+build-1"), "latest");
  assert.equal(
    releaseTag([{ name: "create-project-calavera", version: "2.4.0-next.1" }], "a".repeat(40)),
    "v2.4.0-next.1",
  );
  assert.equal(releaseTag([], "abcdef1234567890"), "packages-abcdef123456");
});

test("release options require an explicit tag value", () => {
  assert.deepEqual(parseOptions(["--tag", "v2.4.0-next.1", "--yes"]), {
    yes: true,
    bootstrap: false,
    tag: "v2.4.0-next.1",
  });
  assert.throws(() => parseOptions(["--tag"]), /requires a following value/);
  assert.throws(() => parseOptions(["--tag", "--yes"]), /requires a following value/);
});

test("trusted publisher verification uses npm's structured response", () => {
  assert.equal(
    hasExpectedTrust({
      id: "publisher-id",
      type: "github",
      file: "publish.yml",
      repository: "schalkneethling/create-project-calavera",
      environment: "publish",
      permissions: ["createPackage"],
    }),
    true,
  );
  assert.equal(
    hasExpectedTrust({
      type: "github",
      file: "publish.yml",
      repository: "schalkneethling/create-project-calavera",
      environment: "publish",
      permissions: ["createStagedPackage"],
    }),
    false,
  );
});

test("release workflow polling waits asynchronously within a configurable budget", async () => {
  let polls = 0;
  const delays = [];
  const run = await waitForRun("v2.4.0-next.1", "abc123", {
    pollIntervalMs: 20,
    timeoutMs: 60,
    getRuns() {
      polls += 1;
      return polls === 2
        ? [{ headSha: "abc123", headBranch: "v2.4.0-next.1", databaseId: 42 }]
        : [];
    },
    async delay(milliseconds) {
      delays.push(milliseconds);
    },
  });
  assert.equal(run.databaseId, 42);
  assert.deepEqual(delays, [20]);

  await assert.rejects(
    waitForRun("missing", "abc123", {
      pollIntervalMs: 20,
      timeoutMs: 40,
      getRuns: () => [],
      delay: async () => {},
    }),
    /No publish\.yml run appeared/,
  );
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
  await writeFile(join(directory, "tracked-notes.json"), '{ "before": true }\n');

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

  const preexistingTrackedChange = '{"tracked" : "leave unchanged"}\n';
  const preexistingUntrackedChange = '{"untracked" : "leave unchanged"}\n';
  await writeFile(join(directory, "tracked-notes.json"), preexistingTrackedChange);
  await writeFile(join(directory, "untracked-notes.json"), preexistingUntrackedChange);

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
  assert.equal(
    await readFile(join(directory, "tracked-notes.json"), "utf8"),
    preexistingTrackedChange,
  );
  assert.equal(
    await readFile(join(directory, "untracked-notes.json"), "utf8"),
    preexistingUntrackedChange,
  );

  versionPackages(options);
  assert.equal(await readFile(join(directory, ".changeset", "pre.json"), "utf8"), preState);
});

test("stable version generation preserves ignored private applications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-version-exit-fixture-"));
  await mkdir(join(directory, ".changeset"));
  await mkdir(join(directory, "packages", "fixture"), { recursive: true });
  await mkdir(join(directory, "apps", "unversioned"), { recursive: true });
  await mkdir(join(directory, "apps", "versioned"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "release-exit-fixture",
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
        changelog: "@changesets/cli/changelog",
        commit: false,
        fixed: [],
        linked: [],
        access: "public",
        baseBranch: "main",
        updateInternalDependencies: "patch",
        ignore: ["unversioned-app", "versioned-app"],
        privatePackages: {
          version: false,
          tag: false,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, ".changeset", "pre.json"),
    `${JSON.stringify(
      {
        mode: "exit",
        tag: "next",
        initialVersions: {
          "fixture-package": "1.0.0",
          "versioned-app": "0.1.0",
        },
        changesets: ["one-change"],
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
    `${JSON.stringify({ name: "fixture-package", version: "1.1.0-next.0" }, null, 2)}\n`,
  );
  const unversionedManifest = `${JSON.stringify(
    { name: "unversioned-app", private: true },
    null,
    2,
  )}\n`;
  const versionedManifest = `${JSON.stringify(
    { name: "versioned-app", version: "0.1.0", private: true },
    null,
    2,
  )}\n`;
  const versionedChangelog = "# Existing private app history\n";
  await writeFile(join(directory, "apps", "unversioned", "package.json"), unversionedManifest);
  await writeFile(join(directory, "apps", "versioned", "package.json"), versionedManifest);
  await writeFile(join(directory, "apps", "versioned", "CHANGELOG.md"), versionedChangelog);

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
  const fixtureCommit = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();

  versionPackages({
    rootDir: directory,
    changesetBin: join(root, "node_modules", ".bin", "changeset"),
    formatterBin: join(root, "node_modules", ".bin", "oxfmt"),
  });

  const publicManifest = JSON.parse(
    await readFile(join(directory, "packages", "fixture", "package.json"), "utf8"),
  );
  assert.equal(publicManifest.version, "1.1.0");
  assert.equal(
    await readFile(join(directory, "packages", "fixture", "CHANGELOG.md"), "utf8"),
    `# fixture-package\n\n## 1.1.0\n\n### Minor Changes\n\n- ${fixtureCommit}: Add a fixture feature.\n`,
  );
  assert.equal(
    await readFile(join(directory, "apps", "unversioned", "package.json"), "utf8"),
    unversionedManifest,
  );
  assert.equal(
    await readFile(join(directory, "apps", "versioned", "package.json"), "utf8"),
    versionedManifest,
  );
  assert.equal(
    await readFile(join(directory, "apps", "versioned", "CHANGELOG.md"), "utf8"),
    versionedChangelog,
  );
  await assert.rejects(access(join(directory, "apps", "unversioned", "CHANGELOG.md")), /ENOENT/);
});
