// #965: step 1 of the bundled Calavera skill lists every MCP tool (#933), but an agent also needs
// to know when to call the Baseline tools. These tests fail when either copy's guidance for a
// recipe that selects `stylelint-baseline` stops naming a Baseline tool or the recipe option that
// records the chosen target.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import { recipeCompositionToolNames } from "../src/recipe.js";
import { bundledSkillCopies } from "./bundled-skill-copies.mjs";

const TOOL_LIST_MARKER = "Look for tools named";
const TRIGGER = "the recipe selects `stylelint-baseline`";
const baselineToolNames = recipeCompositionToolNames.filter((name) => name.includes("baseline"));

test("the registered tools include the four Baseline tools", () => {
  assert.equal(baselineToolNames.length, 4);
});

for (const { source, url } of bundledSkillCopies) {
  test(`the bundled Calavera skill at ${source} says when to use each Baseline tool`, async () => {
    const skill = await readFile(url, "utf8");
    const lines = skill.split("\n");
    const guidance = lines.filter((line) => line.includes(TRIGGER));

    assert.ok(
      lines.some((line) => line.includes(TOOL_LIST_MARKER)),
      `${source} no longer has the "${TOOL_LIST_MARKER}" list`,
    );
    // The guidance must sit with the trigger, so a passing mention elsewhere does not count.
    assert.equal(guidance.length, 1, `${source} does not say what to do when ${TRIGGER}`);
    for (const name of [...baselineToolNames, "integrationOptions.stylelint-baseline.available"]) {
      assert.ok(
        guidance[0].includes(`\`${name}\``),
        `${source} does not name \`${name}\` where it says what to do when ${TRIGGER}`,
      );
    }
  });
}
