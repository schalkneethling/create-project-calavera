// #965: step 1 of the bundled Calavera skill lists every MCP tool (#933), but an agent also needs
// to know when to call the Baseline tools. These tests fail when either copy stops naming a
// Baseline tool outside that list, or stops naming the recipe option the recommendation fills.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import { recipeCompositionToolNames } from "../src/recipe.js";
import { bundledSkillCopies } from "./bundled-skill-copies.mjs";

const TOOL_LIST_MARKER = "Look for tools named";
const baselineToolNames = recipeCompositionToolNames.filter((name) => name.includes("baseline"));

test("the registered tools include the four Baseline tools", () => {
  assert.equal(baselineToolNames.length, 4);
});

for (const { source, url } of bundledSkillCopies) {
  test(`the bundled Calavera skill at ${source} says when to use each Baseline tool`, async () => {
    const skill = await readFile(url, "utf8");
    const guidance = skill
      .split("\n")
      .filter((line) => !line.includes(TOOL_LIST_MARKER))
      .join("\n");

    assert.notEqual(guidance, skill, `${source} no longer has the "${TOOL_LIST_MARKER}" list`);
    for (const name of baselineToolNames) {
      assert.ok(
        guidance.includes(`\`${name}\``),
        `${source} names \`${name}\` only in the tool list, not in guidance on when to use it`,
      );
    }
    assert.ok(
      guidance.includes("`integrationOptions.stylelint-baseline.available`"),
      `${source} does not say where the chosen Baseline target goes in the recipe`,
    );
  });
}
