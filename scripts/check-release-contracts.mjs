import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const changesets = await readJson(".changeset/config.json");
const publishWorkflow = await readFile(".github/workflows/publish.yml", "utf8");
const menuWorkflow = await readFile(".github/workflows/menu-bar-release.yml", "utf8");
const workspace = await readFile("pnpm-workspace.yaml", "utf8");

assert.deepEqual(changesets.fixed, [], "public packages must not share a fixed version group");
assert.deepEqual(changesets.linked, [], "public package versions must not be linked");
for (const application of [
  "@calavera/composer",
  "@calavera/baseline-explorer",
  "@calavera/menu-bar",
]) {
  assert(
    changesets.ignore.includes(application),
    `${application} must remain outside npm Changesets`,
  );
}
assert.match(workspace, /packages:\n\s+- "apps\/\*"/);
assert.match(workspace, /- "packages\/artifacts\/\*"/);
assert.match(publishWorkflow, /\[\[ "\$package_version" == \*-\* \]\]/);
assert.match(publishWorkflow, /dist_tag=next/);
assert.match(publishWorkflow, /npm publish .*--provenance.*--tag "\$dist_tag"/);
assert.match(publishWorkflow, /Skipping already published/);
assert.match(menuWorkflow, /tags: \["menu-bar-v\*"\]/);
assert.match(menuWorkflow, /--target universal-apple-darwin/);
assert.match(menuWorkflow, /environment: publish/);

console.log("Release boundaries and channels satisfy the documented contracts.");
