// Issue #830: the CLI recognizes an earlier release's guidance by SHA-256 digests of what every
// published release wrote. These tests keep those digests honest: they must agree with the texts
// committed in fixtures/agent-guidance, and the text this checkout writes must be registered, so
// changing a template without recording the text it replaces fails here and not in a person's
// project.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { EARLIER_TEMPLATES, findEarlierGuidance } from "../src/utils/earlier-guidance.js";
import {
  currentText,
  epochs,
  guidanceText,
  mcpText,
  packageManagers,
} from "./earlier-guidance-fixtures.mjs";

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

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
  const { id, releases } = epochs.mcp[epochs.mcp.length - 1];
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
