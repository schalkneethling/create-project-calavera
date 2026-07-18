import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const changesets = await readJson(".changeset/config.json");
const publishWorkflow = await readFile(".github/workflows/publish.yml", "utf8");
const menuWorkflow = await readFile(".github/workflows/menu-bar-release.yml", "utf8");
const workspace = await readFile("pnpm-workspace.yaml", "utf8");
const rootPackage = await readJson("package.json");

const publicPackagePaths = ["packages/artifact-core", "packages/baseline-core", "packages/cli"];
for (const entry of await readdir("packages/artifacts", { withFileTypes: true })) {
  if (entry.isDirectory()) publicPackagePaths.push(join("packages/artifacts", entry.name));
}
const publicPackages = await Promise.all(
  publicPackagePaths.map((path) => readJson(join(path, "package.json"))),
);
const applications = await Promise.all(
  ["apps/composer", "apps/baseline-explorer", "apps/menu-bar"].map((path) =>
    readJson(join(path, "package.json")),
  ),
);
assert.equal(
  new Set(publicPackages.map(({ name }) => name)).size,
  publicPackages.length,
  "every public workspace must have an independent package identity",
);
assert.equal(
  publicPackages.every(({ private: isPrivate }) => isPrivate !== true),
  true,
  "releaseable workspaces must remain public",
);
assert.equal(
  applications.every(({ private: isPrivate }) => isPrivate === true),
  true,
  "independently deployed applications must remain private npm workspaces",
);

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
assert.match(rootPackage.scripts["release:fixture"], /targeted update preserves other artifacts/);
assert.match(rootPackage.scripts["release:rehearse"], /@calavera\/baseline-explorer build/);
assert.match(rootPackage.scripts["release:rehearse"], /@calavera\/menu-bar build:web/);
assert.match(workspace, /packages:\n\s+- "apps\/\*"/);
assert.match(workspace, /- "packages\/artifacts\/\*"/);
assert.match(publishWorkflow, /npm view .*version >"\$view_output" 2>&1/);
assert.match(publishWorkflow, /grep -Eq .*E404\|404/);
assert.match(publishWorkflow, /exit "\$view_status"/);
assert.match(publishWorkflow, /\[\[ "\$package_version" == \*-\* \]\]/);
assert.match(publishWorkflow, /dist_tag=next/);
assert.match(publishWorkflow, /npm publish .*--provenance.*--tag "\$dist_tag"/);
assert.match(publishWorkflow, /Skipping already published/);
assert.match(menuWorkflow, /tags: \["menu-bar-v\*"\]/);
assert.match(menuWorkflow, /--target universal-apple-darwin/);
assert.match(menuWorkflow, /environment: publish/);

console.info("Release boundaries and channels satisfy the documented contracts.");
