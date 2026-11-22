// #1167: `--reown-managed-file` (and the MCP input `reownManagedFiles`) lets apply overwrite a
// tracked managed file that has local edits with Calavera's contents. Every description of it must
// say that the edit is replaced and lost unless the person saved it, and none may present it as a
// way to keep the edit, because the C8 rule is that local edits are preserved.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listingViolations, namedItems } from "../../../scripts/rehearsal-checks.mjs";
import { applySummaryLines } from "../src/apply-summary.js";
import { applyRecipeObject, formatHelp } from "../src/index.js";
import { buildRecipe, recipeToolInputDescriptions } from "../src/recipe.js";
import { bundledSkillCopies } from "./bundled-skill-copies.mjs";

// Wording that reads as keeping the current contents.
const KEEPS_EDIT =
  /approved managed-file baseline|\bas approved\b|\bas the baseline\b|intentional local state/;

/**
 * Applies a stylelint recipe, edits the managed `.stylelintrc.json`, and runs `body` in the project.
 *
 * @param {() => Promise<void>} body
 */
async function withEditedManagedFile(body) {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-reown-wording-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await applyRecipeObject(buildRecipe("default", ["stylelint"], "npm"), {
      json: true,
      noInstall: true,
      assumeYes: true,
    });
    const installed = JSON.parse(await readFile(".stylelintrc.json", "utf8"));
    await writeFile(".stylelintrc.json", `${JSON.stringify(installed, null, 4)}\n`);
    await body();
  } finally {
    process.chdir(originalDirectory);
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

const nextRecipe = () =>
  buildRecipe("default", ["stylelint", "stylelint-standard", "stylelint-order"], "npm");

test("the dry run's managed-file-reown warning says apply replaces the edited file, and the summary line names only that file", async () => {
  await withEditedManagedFile(async () => {
    const dryRun = await applyRecipeObject(nextRecipe(), {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
      reownManagedFiles: [".stylelintrc.json"],
    });
    const message =
      ".stylelintrc.json has local edits relative to Calavera state; apply will replace its current contents with Calavera's, so the edits are lost unless you save a copy first.";
    const warning = dryRun.projectInspection.findings.find(
      ({ kind }) => kind === "managed-file-reown",
    );
    assert.equal(warning?.message, message);

    const output = applySummaryLines(dryRun, { noInstall: true })
      .map(({ text }) => text)
      .join("\n");
    assert.equal(
      output.split("\n").filter((line) => line === `  Inspection warning: ${message}`).length,
      1,
      output,
    );
    assert.doesNotMatch(output, KEEPS_EDIT);
    // The warning line names the file it is about and no other planned item. Other inspection
    // findings in this output repeated `.stylelintrc.json` and `stylelint` before this change, so
    // the whole output is not checked for duplicates here.
    for (const item of namedItems(JSON.parse(JSON.stringify(dryRun)))) {
      if (item !== ".stylelintrc.json") {
        // `listingViolations` matches whole names, so `stylelint` inside `.stylelintrc.json` does not
        // count; it reports an item the line does not name as printed 0 times.
        assert.deepEqual(
          listingViolations(message, [item]),
          [`${item} is printed 0 times`],
          `the warning also names ${item}`,
        );
      }
    }
  });
});

test("--help says --reown-managed-file replaces the file's contents and the edits are lost", () => {
  const help = formatHelp();

  assert.match(
    help,
    /--reown-managed-file <path>\n {23}Replace an edited, tracked managed file's contents with\n {23}Calavera's; the edits are lost unless you save a copy first\n/,
  );
  assert.doesNotMatch(help, KEEPS_EDIT);
});

test("the MCP reownManagedFiles input says apply replaces the contents and the edits are lost", () => {
  const description = recipeToolInputDescriptions.reownManagedFiles;

  assert.match(description, /replaces each file's current contents with Calavera's/);
  assert.match(description, /edits are lost unless the user saved a copy/);
  assert.doesNotMatch(description, KEEPS_EDIT);
});

for (const { source, url } of bundledSkillCopies) {
  test(`the bundled Calavera skill at ${source} says reownManagedFiles replaces the edits`, async () => {
    const skill = await readFile(url, "utf8");
    const guidance = skill.split("\n").filter((line) => line.includes("`reownManagedFiles`"));

    assert.equal(guidance.length, 1, `${source} should describe reownManagedFiles on one line`);
    assert.match(guidance[0], /replaces each listed file's current contents with Calavera's/);
    assert.match(guidance[0], /edits are lost unless they save a copy first/);
    assert.match(guidance[0], /[Nn]ever use it to keep an edit/);
    assert.doesNotMatch(guidance[0], KEEPS_EDIT);
  });
}
