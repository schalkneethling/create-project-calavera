// Issue #1033: apply reports each temporary folder it could not remove in temporaryFolderLeftovers
// and still finishes. The bundled Calavera skill asks agents to show those folders to the user as a
// warning with the remedy, next to the other apply result fields it lists in step 10.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bundledSkillCopies } from "./bundled-skill-copies.mjs";

for (const { source, url } of bundledSkillCopies) {
  test(`the bundled Calavera skill at ${source} shows temporaryFolderLeftovers as a warning with its remedy`, async () => {
    const step = (await readFile(url, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("10. Call `apply_recipe`"));

    assert.ok(step, `${source} has no step 10 about apply_recipe`);
    assert.match(step, /`stagingLeftovers`/);
    assert.match(
      step,
      /show each entry in `temporaryFolderLeftovers` as a warning with its remedy/,
      `${source} does not ask agents to show temporaryFolderLeftovers`,
    );
  });
}
