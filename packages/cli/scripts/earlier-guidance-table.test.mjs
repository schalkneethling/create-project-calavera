// Issue #830: the CLI recognizes an earlier release's guidance by SHA-256 digests of what every
// published release wrote. These tests keep those digests honest: they must agree with the texts
// committed in fixtures/agent-guidance, and the text this checkout writes must be registered, so
// changing a template without recording the text it replaces fails here and not in a person's
// project.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assembleReleasePlan } from "@changesets/assemble-release-plan";
import { readConfig } from "@changesets/config";
import { readPreState } from "@changesets/pre";
import { readChangesets } from "@changesets/read";
import { getPackages } from "@manypkg/get-packages";
import semver from "semver";

import packageJson from "../package.json" with { type: "json" };
import {
  EARLIER_TEMPLATES,
  findEarlierGuidance,
  normalizePublishedPin,
} from "../src/utils/earlier-guidance.js";
import {
  currentText,
  epochs,
  guidanceText,
  mcpText,
  packageManagers,
} from "./earlier-guidance-fixtures.mjs";

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const { version } = packageJson;

test("Given the committed release fixtures, then the digests the CLI holds are exactly their digests", async () => {
  const expected = {
    guidance: await Promise.all(
      epochs.guidance.map(async ({ id, releases }) => ({
        releases,
        sha256: [sha256(await guidanceText(id))],
      })),
    ),
    mcp: await Promise.all(
      epochs.mcp.map(async ({ id, releases, pinned }) => ({
        releases,
        pinned,
        // The fixture keeps the {{version}} placeholder, which is what the CLI hashes.
        sha256: await Promise.all(
          packageManagers.map(async (packageManager) =>
            sha256(await mcpText(id, packageManager, "{{version}}")),
          ),
        ),
      })),
    ),
  };
  // A guidance template does not say whether it pins a version, so the CLI does not either.
  assert.deepEqual(EARLIER_TEMPLATES, expected);
});

test("Given the list of published releases, then each one is in exactly one template of each kind", () => {
  const published = epochs.guidance.flatMap(({ releases }) => releases);
  assert.equal(new Set(published).size, published.length, "a release is in two guidance templates");
  const mcpPublished = epochs.mcp.flatMap(({ releases }) => releases);
  assert.equal(
    new Set(mcpPublished).size,
    mcpPublished.length,
    "a release is in two mcp templates",
  );
  assert.deepEqual([...mcpPublished].sort(), [...published].sort());
  for (const release of published) {
    assert.match(release, /^\d+\.\d+\.\d+(-next\.\d+)?$/);
  }
});

test("Given a fixture, when it is read back as a project file, then the CLI names the releases that wrote it", async () => {
  for (const { id, releases } of epochs.guidance) {
    const earlier = findEarlierGuidance("guidance", await guidanceText(id));
    assert.deepEqual(earlier?.releases, releases, `guidance ${id}`);
  }
  for (const { id, releases } of epochs.mcp) {
    for (const packageManager of packageManagers) {
      for (const release of releases) {
        const earlier = findEarlierGuidance("mcp", await mcpText(id, packageManager, release));
        assert.deepEqual(earlier?.releases, releases, `mcp ${id} ${packageManager} ${release}`);
      }
    }
  }
});

test("Given a pinned setup note, then it names the release it pins and the kinds do not match each other", async () => {
  // The latest template that more than two releases wrote, so the test can pin two of them.
  const { id, releases } = /** @type {(typeof epochs.mcp)[number]} */ (
    epochs.mcp.findLast(({ releases: written }) => written.length > 2)
  );
  const text = await mcpText(id, "pnpm", releases[1]);
  assert.equal(findEarlierGuidance("mcp", text)?.description, releases[1]);
  assert.equal(findEarlierGuidance("guidance", text), undefined);
  assert.equal(findEarlierGuidance("mcp", await guidanceText(epochs.guidance[0].id)), undefined);
  // A text that pins two different releases was never written by one.
  const mixed = text.replace(
    `create-project-calavera@${releases[1]}`,
    `create-project-calavera@${releases[2]}`,
  );
  assert.equal(findEarlierGuidance("mcp", mixed), undefined);
});

test("Given the text this checkout writes, then an earlier release's template is registered for it", async () => {
  // The next release changes the version the setup notes pin, so the check swaps in a version the
  // table lists. What it proves is that the template's shape is registered, which a text change
  // breaks.
  const lastMcp = epochs.mcp[epochs.mcp.length - 1];
  const lastGuidance = epochs.guidance[epochs.guidance.length - 1];
  for (const packageManager of packageManagers) {
    const current = await currentText(packageManager);
    assert.deepEqual(
      findEarlierGuidance("guidance", current.agents)?.releases,
      lastGuidance.releases,
      `AGENTS.md for ${packageManager}: the text this checkout writes is not registered: add it to fixtures/agent-guidance and its digest to src/utils/earlier-guidance.js, keeping the earlier texts`,
    );
    assert.deepEqual(
      findEarlierGuidance("guidance", current.fallback)?.releases,
      lastGuidance.releases,
      `AGENTS.calavera.md for ${packageManager}: the text this checkout writes is not registered: add it to fixtures/agent-guidance and its digest to src/utils/earlier-guidance.js, keeping the earlier texts`,
    );
    const pinned = current.mcp.replaceAll(
      /create-project-calavera@\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?/g,
      `create-project-calavera@${lastMcp.releases[0]}`,
    );
    assert.deepEqual(
      findEarlierGuidance("mcp", pinned)?.releases,
      lastMcp.releases,
      `mcp.md for ${packageManager}: the text this checkout writes is not registered: add it to fixtures/agent-guidance and its digest to src/utils/earlier-guidance.js, keeping the earlier texts`,
    );
  }
});

/**
 * Issue #935: says why `version`, the version in package.json, is not listed where it must be, or
 * nothing when it is. The last template is the text this checkout writes. It must list `version`,
 * unless the text changed since `version` was published: then an earlier template lists
 * `version`, and the last one lists the release that will publish the new text. So the Version
 * Packages pull request, which raises `version` to one no template lists, fails until the table
 * lists it, while a pull request that changes a template text can still pass.
 *
 * @param {{ releases: string[] }[]} kindEpochs The templates of one kind, oldest first.
 * @param {string} version
 * @returns {string | undefined}
 */
function unlistedVersion(kindEpochs, version) {
  const current = kindEpochs[kindEpochs.length - 1];
  if (current.releases.includes(version)) return undefined;
  if (kindEpochs.slice(0, -1).some(({ releases }) => releases.includes(version))) return undefined;
  return `${version} is in no template: on main, not on the Version Packages branch, which Changesets regenerates, add it to the releases of the last template in fixtures/agent-guidance/epochs.json and src/utils/earlier-guidance.js`;
}

test("Given the version this checkout publishes, then the table lists it", async () => {
  for (const [file, kindEpochs] of [
    ["AGENTS.md", epochs.guidance],
    [".agents/calavera/mcp.md", epochs.mcp],
  ]) {
    const problem = unlistedVersion(kindEpochs, version);
    assert.equal(problem, undefined, `${file}: ${problem}`);
  }
  // When the text this checkout writes is the one `version` wrote, the files read back as that
  // release's, pinned version included.
  for (const packageManager of packageManagers) {
    const current = await currentText(packageManager);
    if (epochs.guidance[epochs.guidance.length - 1].releases.includes(version)) {
      assert.ok(
        findEarlierGuidance("guidance", current.agents)?.releases.includes(version),
        `AGENTS.md for ${packageManager}`,
      );
    }
    if (epochs.mcp[epochs.mcp.length - 1].releases.includes(version)) {
      assert.ok(
        findEarlierGuidance("mcp", current.mcp)?.releases.includes(version),
        `mcp.md for ${packageManager}`,
      );
    }
  }
});

test("Given a version bump or a changed template, then the release check fails only for the bump", () => {
  const published = [{ releases: ["6.1.0"] }, { releases: ["6.2.0", "6.2.1"] }];
  assert.equal(unlistedVersion(published, "6.2.1"), undefined);
  // The Version Packages pull request raised the version and nobody listed it.
  assert.match(unlistedVersion(published, "6.3.0") ?? "", /^6\.3\.0 is in no template/);
  // A pull request changed the text: the new template names the release that will publish it,
  // and package.json still holds the release that wrote the earlier text.
  const changed = [...published, { releases: ["6.3.0"] }];
  assert.equal(unlistedVersion(changed, "6.2.1"), undefined);
  assert.equal(unlistedVersion(changed, "6.3.0"), undefined);
  // The same pull request, with the version raised past the one the new template names.
  assert.match(unlistedVersion(changed, "6.4.0") ?? "", /^6\.4\.0 is in no template/);
});

/**
 * Issue #1219: the listed versions that npm does not have and that no release will publish.
 * `normalizePublishedPin` treats a listed version older than package.json's as published, so a
 * template may name an unpublished version only while it is newer: package.json's own version
 * (between the Version Packages merge and the GitHub release that publishes it) and `next`, the
 * version the pending changesets produce. Any other listed version newer than `previous`, the
 * release before package.json's version, is a guess at a release that will not happen, such as
 * 6.3.0 once a major changeset made the next release 7.0.0.
 *
 * @param {{ releases: string[] }[]} kindEpochs The templates of one kind.
 * @param {{ previous: string, version: string, next: string }} versions
 * @returns {string[]}
 */
function unexpectedListedVersions(kindEpochs, { previous, version, next }) {
  return kindEpochs
    .flatMap(({ releases }) => releases)
    .filter((release) => semver.gt(release, previous) && release !== version && release !== next);
}

/** The version the pending changesets give create-project-calavera, read offline as Changesets does. */
async function nextVersion() {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const packages = await getPackages(root);
  const { config, errors } = await readConfig(root, packages);
  assert.equal(errors, undefined, "the Changesets config reads without errors");
  // No `since` reference, so Changesets reads the files in .changeset and never asks Git.
  const plan = assembleReleasePlan(
    await readChangesets(root),
    packages,
    config,
    await readPreState(root),
  );
  return plan.releases.find(({ name }) => name === packageJson.name)?.newVersion ?? version;
}

/** The newest release in CHANGELOG.md older than package.json's version. */
async function previousRelease() {
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const releases = [...changelog.matchAll(/^## (\S+)$/gm)]
    .map((match) => match[1])
    .filter((release) => semver.valid(release) && semver.lt(release, version));
  return releases.sort(semver.rcompare)[0];
}

test("Given the pending changesets, then the table names no unpublished version they will not produce", async () => {
  const previous = await previousRelease();
  assert.ok(previous, "CHANGELOG.md names a release before package.json's version");
  // The boundary is strictly older than package.json's version, so on the Version Packages commit a
  // guess listed between the last release and the new version is still flagged.
  assert.ok(
    semver.lt(previous, version),
    `the release before ${version} is older than ${version}, not ${previous}`,
  );
  const next = await nextVersion();
  for (const [file, kindEpochs] of [
    ["AGENTS.md", epochs.guidance],
    [".agents/calavera/mcp.md", epochs.mcp],
  ]) {
    assert.deepEqual(
      unexpectedListedVersions(kindEpochs, { previous, version, next }),
      [],
      next === version
        ? `${file}: after ${previous}, the templates may list only ${version}, because no pending changeset releases ${packageJson.name}. Add the changeset for the change that wrote the listed text, or remove the listed version, on main, in fixtures/agent-guidance/epochs.json and src/utils/earlier-guidance.js`
        : `${file}: after ${previous}, the templates may list only ${version} and ${next}, the version the pending changesets produce. Rename any other listed version to ${next}, on main, in fixtures/agent-guidance/epochs.json and src/utils/earlier-guidance.js`,
    );
  }
});

test("Given a guessed next release, then the check fails on main and on the Version Packages commit", () => {
  // #1219: #1089 listed 6.3.0, then a major changeset made the next release 7.0.0.
  const guessed = [{ releases: ["6.1.0", "6.2.0", "6.2.1"] }, { releases: ["6.3.0"] }];
  assert.deepEqual(
    unexpectedListedVersions(guessed, { previous: "6.2.0", version: "6.2.1", next: "7.0.0" }),
    ["6.3.0"],
  );
  // The Version Packages commit, after the release check asked for 7.0.0 to be listed too.
  const both = [{ releases: ["6.1.0", "6.2.0", "6.2.1"] }, { releases: ["6.3.0", "7.0.0"] }];
  assert.deepEqual(
    unexpectedListedVersions(both, { previous: "6.2.1", version: "7.0.0", next: "7.0.0" }),
    ["6.3.0"],
  );
  // Renamed to the version the changesets produce, the table passes before and after the bump.
  const renamed = [{ releases: ["6.1.0", "6.2.0", "6.2.1"] }, { releases: ["7.0.0"] }];
  assert.deepEqual(
    unexpectedListedVersions(renamed, { previous: "6.2.0", version: "6.2.1", next: "7.0.0" }),
    [],
  );
  assert.deepEqual(
    unexpectedListedVersions(renamed, { previous: "6.2.1", version: "7.0.0", next: "7.0.0" }),
    [],
  );
});

test("Given an earlier release's text, then the description names one release, a range of releases, or the pinned release", async () => {
  const description = async (id) =>
    findEarlierGuidance("guidance", await guidanceText(id))?.description;
  assert.equal(await description("2.0.6"), "2.0.6");
  assert.equal(await description("2.0.0"), "2.0.0 to 2.0.4");
  assert.equal(await description("3.0.0"), "3.0.0 to 6.0.0");
  // A text that pins no version names its range, because every release in it wrote the same text.
  const unpinned = epochs.mcp.find(({ pinned }) => !pinned);
  assert.equal(
    findEarlierGuidance("mcp", await mcpText(unpinned.id, "npm", ""))?.description,
    `${unpinned.releases[0]} to ${unpinned.releases[unpinned.releases.length - 1]}`,
  );
});

test("Given a pinned version, then normalizePublishedPin normalizes it only when npm has it", () => {
  const pin = (/** @type {string} */ value) => `npx --package create-project-calavera@${value} mcp`;
  const normalized = "npx --package create-project-calavera@{{version}} mcp";
  // #1219: a listed version older than the one this checkout writes was published before it.
  for (const published of ["5.0.0", "2.3.0-next.2", "6.2.0"]) {
    assert.equal(normalizePublishedPin(pin(published), "6.2.1"), normalized, published);
  }
  // The version this checkout writes counts, listed or not, so its own entries stay Calavera's.
  assert.equal(normalizePublishedPin(pin("6.2.1"), "6.2.1"), normalized);
  assert.equal(normalizePublishedPin(pin("99.0.0"), "99.0.0"), normalized);
  // A listed version newer than this checkout's, such as the upcoming 7.0.0, is not published yet.
  assert.equal(normalizePublishedPin(pin("7.0.0"), "6.2.1"), undefined);
  // The Version Packages commit for 7.0.0: 7.0.0 is the version written, and 6.2.1 is published.
  // 6.3.0, which #1089 listed as a guess before a major changeset made the next release 7.0.0,
  // is no longer listed, so it counts only as an unlisted version. The table test above keeps
  // such a guess out of the list, which is what stops it counting as an older release (#1219).
  assert.equal(normalizePublishedPin(pin("7.0.0"), "7.0.0"), normalized);
  assert.equal(normalizePublishedPin(pin("6.2.1"), "7.0.0"), normalized);
  assert.equal(normalizePublishedPin(pin("6.3.0"), "7.0.0"), undefined);
  assert.equal(normalizePublishedPin(pin("5.0.0"), "4.1.0"), undefined);
  // An unlisted version, an unlisted prerelease, no pin, the placeholder, and no written version.
  for (const text of [pin("99.0.0"), pin("6.2.1-next.0"), "npx create-project-calavera mcp"]) {
    assert.equal(normalizePublishedPin(text, "6.2.1"), undefined, text);
  }
  assert.equal(normalizePublishedPin(normalized, "6.2.1"), undefined);
  assert.equal(normalizePublishedPin(pin("5.0.0"), undefined), undefined);
});
