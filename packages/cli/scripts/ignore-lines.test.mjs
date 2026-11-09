// Issue #733 and ADR-0016: an integration declares the lines it needs in `.gitignore` and in the
// managed `.htmlvalidateignore` in an `ignore` field of its catalog entry. Apply writes the
// `.gitignore` lines as one marked block per integration, keeps every other line byte for byte,
// removes or replaces the block only while it holds what apply recorded, and stops on an edit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrationCatalog } from "../src/catalog.js";
import {
  htmlValidateIgnoreText,
  ignoreLineProblem,
  planGitignoreBlocks,
  planHtmlValidateIgnoreChanges,
} from "../src/ignore-lines.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { normalizeState } from "../src/state.js";
import { fixture } from "./ignore-fixture-integration.mjs";
import { packageDirectory } from "./installed-package.mjs";

// ---------------------------------------------------------------------------------------------
// The planner, on file contents alone.
// ---------------------------------------------------------------------------------------------

const stryker = { integration: "stryker", lines: [".stryker-tmp/", "reports/mutation/"] };
const strykerBlock =
  "# calavera:stryker:start\n.stryker-tmp/\nreports/mutation/\n# calavera:stryker:end\n";
// The person's own file, with a comment, a blank line, and a negation, all of which must survive.
const own = "node_modules/\n# my own rules\n.env\n\n!.env.example\n";

test("without a .gitignore, the planner writes the file with the block alone", () => {
  const plan = planGitignoreBlocks({ contents: undefined, declared: [stryker], records: [] });

  assert.equal(plan.contents, strykerBlock);
  assert.equal(plan.type, "write");
  assert.deepEqual(plan.changes, [
    { path: ".gitignore", integration: "stryker", type: "write", lines: stryker.lines },
  ]);
  assert.deepEqual(plan.records, [stryker]);
});

test("the block is appended after the person's lines, which stay byte for byte and in order", () => {
  const plan = planGitignoreBlocks({ contents: own, declared: [stryker], records: [] });

  assert.equal(plan.contents, `${own}${strykerBlock}`);
  assert.equal(plan.type, "update");
  assert.deepEqual(plan.changes, [
    { path: ".gitignore", integration: "stryker", type: "update", lines: stryker.lines },
  ]);
});

test("a last line without a line break gets one before the block, and an empty file gets none", () => {
  assert.equal(
    planGitignoreBlocks({ contents: "node_modules/", declared: [stryker], records: [] }).contents,
    `node_modules/\n${strykerBlock}`,
  );
  assert.equal(
    planGitignoreBlocks({ contents: "", declared: [stryker], records: [] }).contents,
    strykerBlock,
  );
});

test("a file with Windows line endings gets them on the block too, and is unchanged after", () => {
  const crlf = "node_modules/\r\n.env\r\n";
  const plan = planGitignoreBlocks({ contents: crlf, declared: [stryker], records: [] });

  assert.equal(plan.contents, `${crlf}${strykerBlock.replaceAll("\n", "\r\n")}`);
  const again = planGitignoreBlocks({
    contents: plan.contents,
    declared: [stryker],
    records: [stryker],
  });
  assert.equal(again.type, "unchanged");
  assert.equal(again.contents, plan.contents);
});

test("blocks follow the order of the declared integrations", () => {
  const other = { integration: "other", lines: ["tmp/"] };
  const plan = planGitignoreBlocks({ contents: own, declared: [stryker, other], records: [] });

  assert.equal(
    plan.contents,
    `${own}${strykerBlock}# calavera:other:start\ntmp/\n# calavera:other:end\n`,
  );
  assert.deepEqual(plan.records, [stryker, other]);
});

test("a block that already holds the declared lines is unchanged, with or without a record", () => {
  for (const records of [[stryker], []]) {
    const plan = planGitignoreBlocks({
      contents: `${own}${strykerBlock}`,
      declared: [stryker],
      records,
    });

    assert.equal(plan.type, "unchanged");
    assert.equal(plan.contents, `${own}${strykerBlock}`);
    assert.deepEqual(plan.changes, [
      { path: ".gitignore", integration: "stryker", type: "unchanged", lines: stryker.lines },
    ]);
    assert.deepEqual(plan.records, [stryker]);
  }
});

test("a block that holds the recorded lines is replaced when the catalog declares new ones", () => {
  const previous = { integration: "stryker", lines: [".stryker-tmp/", "reports/"] };
  const contents = `${own}# calavera:stryker:start\n.stryker-tmp/\nreports/\n# calavera:stryker:end\nafter/\n`;
  const plan = planGitignoreBlocks({ contents, declared: [stryker], records: [previous] });

  assert.equal(plan.contents, `${own}${strykerBlock}after/\n`);
  assert.equal(plan.type, "update");
  assert.deepEqual(plan.changes, [
    {
      path: ".gitignore",
      integration: "stryker",
      type: "update",
      lines: stryker.lines,
      previousLines: previous.lines,
    },
  ]);
});

test("an edited block is a conflict that shows both texts, not a silent overwrite", () => {
  const edited = `${own}# calavera:stryker:start\n.stryker-tmp/\nreports/\n# calavera:stryker:end\n`;

  assert.throws(
    () => planGitignoreBlocks({ contents: edited, declared: [stryker], records: [stryker] }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Calavera stopped before writing anything/);
      assert.match(error.message, /\.gitignore: the Calavera block for stryker was edited/);
      assert.match(error.message, /The file now holds:\n {2}\.stryker-tmp\/\n {2}reports\/\n/);
      assert.match(error.message, /Calavera wrote:\n {2}\.stryker-tmp\/\n {2}reports\/mutation\//);
      return true;
    },
  );
});

test("a block Calavera has no record of, holding other lines, is a conflict", () => {
  const foreign = `# calavera:stryker:start\nmine/\n# calavera:stryker:end\n`;

  assert.throws(
    () => planGitignoreBlocks({ contents: foreign, declared: [stryker], records: [] }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /\.gitignore: the Calavera block for stryker is already in the file, and Calavera has no record of writing it\.\nThe file now holds:\n {2}mine\//,
      );
      assert.doesNotMatch(error.message, /Calavera wrote:/);
      return true;
    },
  );
});

test("an unpaired or changed marker is a conflict, because the block's end is unknown", () => {
  assert.throws(
    () =>
      planGitignoreBlocks({
        contents: `${own}# calavera:stryker:start\n.stryker-tmp/\n`,
        declared: [stryker],
        records: [stryker],
      }),
    /has a start marker without an end marker/,
  );
  assert.throws(
    () =>
      planGitignoreBlocks({
        contents: `${own}  # calavera:stryker:start\n.stryker-tmp/\n# calavera:stryker:end\n`,
        declared: [stryker],
        records: [stryker],
      }),
    /a marker line was changed/,
  );
});

test("a recorded block whose integration is no longer declared is removed, giving back the original bytes", () => {
  const plan = planGitignoreBlocks({
    contents: `${own}${strykerBlock}`,
    declared: [],
    records: [stryker],
  });

  assert.equal(plan.contents, own);
  assert.equal(plan.type, "update");
  assert.deepEqual(plan.changes, [
    { path: ".gitignore", integration: "stryker", type: "update", removedLines: stryker.lines },
  ]);
  assert.deepEqual(plan.records, []);
});

test("removing a block at the end of a file without a final line break keeps the line before it intact", () => {
  for (const [before, eol] of [
    ["a\n", "\n"],
    ["a\r\n", "\r\n"],
  ]) {
    const block = strykerBlock.replaceAll("\n", eol).slice(0, -eol.length);
    const plan = planGitignoreBlocks({
      contents: `${before}${block}`,
      declared: [],
      records: [stryker],
    });
    assert.equal(plan.contents, before);
  }
  // A file that held only the block, without a final line break, is left empty.
  assert.equal(
    planGitignoreBlocks({ contents: strykerBlock.slice(0, -1), declared: [], records: [stryker] })
      .contents,
    "",
  );
});

test("a replaced block keeps the line ending of its own markers", () => {
  const previous = { integration: "stryker", lines: [".stryker-tmp/"] };
  const contents = "a\r\nb\r\n# calavera:stryker:start\n.stryker-tmp/\n# calavera:stryker:end\n";
  const plan = planGitignoreBlocks({ contents, declared: [stryker], records: [previous] });

  assert.equal(plan.contents, `a\r\nb\r\n${strykerBlock}`);
});

test("removing one integration's block keeps the other integration's block", () => {
  const other = { integration: "other", lines: ["tmp/"] };
  const otherBlock = "# calavera:other:start\ntmp/\n# calavera:other:end\n";
  const plan = planGitignoreBlocks({
    contents: `${own}${strykerBlock}${otherBlock}`,
    declared: [other],
    records: [stryker, other],
  });

  assert.equal(plan.contents, `${own}${otherBlock}`);
  assert.deepEqual(plan.records, [other]);
});

test("an edited block of an integration that is no longer declared is a conflict, not a deletion", () => {
  const edited = `${own}# calavera:stryker:start\n.stryker-tmp/\nmine/\n# calavera:stryker:end\n`;

  assert.throws(
    () => planGitignoreBlocks({ contents: edited, declared: [], records: [stryker] }),
    /\.gitignore: stryker no longer adds lines to \.gitignore, so Calavera would remove its block, but the block was edited since Calavera wrote it/,
  );
});

test("a recorded block the person already removed needs no change and drops its record", () => {
  const plan = planGitignoreBlocks({ contents: own, declared: [], records: [stryker] });

  assert.equal(plan.contents, own);
  assert.equal(plan.type, undefined);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.records, []);
});

test("with nothing declared and nothing recorded, the planner touches nothing", () => {
  for (const contents of [undefined, own]) {
    const plan = planGitignoreBlocks({ contents, declared: [], records: [] });
    assert.equal(plan.type, undefined);
    assert.equal(plan.contents, contents);
    assert.deepEqual(plan.changes, []);
  }
});

test("without a .gitignore, every block the planner adds is a write", () => {
  const other = { integration: "other", lines: ["tmp/"] };
  const plan = planGitignoreBlocks({
    contents: undefined,
    declared: [stryker, other],
    records: [],
  });

  assert.equal(plan.type, "write");
  assert.deepEqual(
    plan.changes.map(({ integration, type }) => ({ integration, type })),
    [
      { integration: "stryker", type: "write" },
      { integration: "other", type: "write" },
    ],
  );
});

test("a record whose .gitignore is gone needs no change", () => {
  const plan = planGitignoreBlocks({ contents: undefined, declared: [], records: [stryker] });

  assert.equal(plan.contents, undefined);
  assert.equal(plan.type, undefined);
  assert.deepEqual(plan.records, []);
});

test("a broken marker in a block Calavera would remove is a conflict", () => {
  assert.throws(
    () =>
      planGitignoreBlocks({
        contents: `${own}# calavera:stryker:start\n.stryker-tmp/\n`,
        declared: [],
        records: [stryker],
      }),
    /\.gitignore: the Calavera block for stryker has a start marker without an end marker/,
  );
});

test("each block is compared with its own integration's record", () => {
  const other = { integration: "other", lines: ["tmp/"] };
  const previous = { integration: "stryker", lines: [".stryker-tmp/"] };
  const plan = planGitignoreBlocks({
    contents: `${own}# calavera:stryker:start\n.stryker-tmp/\n# calavera:stryker:end\n`,
    declared: [stryker],
    records: [other, previous],
  });

  assert.equal(plan.contents, `${own}${strykerBlock}`);
});

test("every conflict is listed on its own line", () => {
  const edited = (/** @type {string} */ id) =>
    `# calavera:${id}:start\nmine/\n# calavera:${id}:end\n`;

  assert.throws(
    () =>
      planGitignoreBlocks({
        contents: `${edited("stryker")}${edited("other")}`,
        declared: [stryker, { integration: "other", lines: ["tmp/"] }],
        records: [],
      }),
    /there:\n- \.gitignore: the Calavera block for stryker[\s\S]*\n- \.gitignore: the Calavera block for other/,
  );
});

test("markers that do not pair up are conflicts that say how they fail to pair", () => {
  const cases = [
    [
      "# calavera:stryker:start\n# calavera:stryker:start\n# calavera:stryker:end\n",
      /has 2 start markers and 1 end marker,/,
    ],
    [
      "# calavera:stryker:start\n# calavera:stryker:end\n# calavera:stryker:end\n",
      /has 1 start marker and 2 end markers,/,
    ],
    ["# calavera:stryker:end\n", /has an end marker without a start marker/],
    [
      "# calavera:stryker:start\n# calavera:stryker:start\n",
      /has 2 start markers and 0 end markers,/,
    ],
    ["# calavera:stryker:end\n# calavera:stryker:end\n", /has 0 start markers and 2 end markers,/],
    [
      "# calavera:stryker:end\n# calavera:stryker:start\n",
      /has an end marker that comes before its start marker/,
    ],
  ];
  for (const [contents, message] of cases) {
    assert.throws(
      () => planGitignoreBlocks({ contents: String(contents), declared: [stryker], records: [] }),
      message,
    );
  }
});

test("a marker with trailing spaces is still a marker", () => {
  const contents = `# calavera:stryker:start  \n.stryker-tmp/\nreports/mutation/\n# calavera:stryker:end\t\n`;
  const plan = planGitignoreBlocks({ contents, declared: [stryker], records: [stryker] });

  assert.equal(plan.type, "unchanged");
});

test("an .htmlvalidateignore change is an update until the file holds every line of the integration", () => {
  const integrations = [{ id: "html-validate", ignore: { htmlValidateIgnore: ["a/", "b/"] } }];

  assert.deepEqual(planHtmlValidateIgnoreChanges(integrations, "a/\n"), [
    {
      path: ".htmlvalidateignore",
      integration: "html-validate",
      type: "update",
      lines: ["a/", "b/"],
    },
  ]);
  assert.deepEqual(planHtmlValidateIgnoreChanges(integrations, "a/\n  \nb/\n"), [
    {
      path: ".htmlvalidateignore",
      integration: "html-validate",
      type: "unchanged",
      lines: ["a/", "b/"],
    },
  ]);
});

test("a block that holds the recorded lines in another order is replaced when the catalog reorders them", () => {
  const previous = { integration: "stryker", lines: ["reports/mutation/", ".stryker-tmp/"] };
  const contents = `${own}# calavera:stryker:start\nreports/mutation/\n.stryker-tmp/\n# calavera:stryker:end\n`;
  const plan = planGitignoreBlocks({ contents, declared: [stryker], records: [previous] });

  assert.equal(plan.contents, `${own}${strykerBlock}`);
  assert.equal(plan.type, "update");
  assert.deepEqual(plan.changes, [
    {
      path: ".gitignore",
      integration: "stryker",
      type: "update",
      lines: stryker.lines,
      previousLines: previous.lines,
    },
  ]);
});

test("an .htmlvalidateignore change shows the old and new order when the catalog reorders an integration's lines", () => {
  const integrations = [{ id: "html-validate", ignore: { htmlValidateIgnore: ["a/", "b/"] } }];
  const current = "b/\na/\n";

  assert.deepEqual(planHtmlValidateIgnoreChanges(integrations, current), [
    {
      path: ".htmlvalidateignore",
      integration: "html-validate",
      type: "update",
      lines: ["a/", "b/"],
      previousLines: ["b/", "a/"],
    },
  ]);
  // The preview must describe what apply writes.
  assert.equal(htmlValidateIgnoreText(integrations), "a/\nb/\n");
});

test("an .htmlvalidateignore change shows a reorder between integrations, because apply writes them in catalog order", () => {
  const integrations = [
    { id: "first", ignore: { htmlValidateIgnore: ["y/", "z/"] } },
    { id: "second", ignore: { htmlValidateIgnore: ["x/"] } },
  ];
  const changes = planHtmlValidateIgnoreChanges(integrations, "x/\ny/\nz/\n");

  assert.deepEqual(
    changes.map(({ integration, type, previousLines }) => ({ integration, type, previousLines })),
    [
      { integration: "first", type: "update", previousLines: ["x/", "y/"] },
      { integration: "second", type: "update", previousLines: ["z/"] },
    ],
  );
  assert.equal(htmlValidateIgnoreText(integrations), "y/\nz/\nx/\n");
});

test("an .htmlvalidateignore line two integrations share counts once, where the first integration writes it", () => {
  const integrations = [
    { id: "first", ignore: { htmlValidateIgnore: ["y/", "z/"] } },
    { id: "second", ignore: { htmlValidateIgnore: ["x/", "y/"] } },
  ];
  const current = htmlValidateIgnoreText(integrations);

  assert.equal(current, "y/\nz/\nx/\n");
  assert.deepEqual(
    planHtmlValidateIgnoreChanges(integrations, current).map(({ type }) => type),
    ["unchanged", "unchanged"],
  );
});

test("a missing .htmlvalidateignore line does not make a later integration look reordered", () => {
  const integrations = [
    { id: "first", ignore: { htmlValidateIgnore: ["a/", "b/"] } },
    { id: "second", ignore: { htmlValidateIgnore: ["c/"] } },
  ];

  assert.deepEqual(
    planHtmlValidateIgnoreChanges(integrations, "a/\nc/\n").map(({ integration, type }) => ({
      integration,
      type,
    })),
    [
      { integration: "first", type: "update" },
      { integration: "second", type: "unchanged" },
    ],
  );
});

test("ignoreLineProblem refuses empty lines, line breaks, and Calavera markers", () => {
  assert.equal(ignoreLineProblem(".stryker-tmp/"), undefined);
  assert.equal(ignoreLineProblem("!.env.schema"), undefined);
  assert.match(ignoreLineProblem("") ?? "", /empty/);
  assert.match(ignoreLineProblem("  ") ?? "", /empty/);
  assert.match(ignoreLineProblem("a\nb") ?? "", /line break/);
  assert.match(ignoreLineProblem("a\rb") ?? "", /line break/);
  assert.match(ignoreLineProblem("# calavera:stryker:end") ?? "", /marker/);
  assert.throws(
    () =>
      planGitignoreBlocks({
        contents: undefined,
        declared: [{ integration: "stryker", lines: ["a\nb"] }],
        records: [],
      }),
    /stryker declares a \.gitignore line that Calavera refuses/,
  );
});

// ---------------------------------------------------------------------------------------------
// The catalog and the state record.
// ---------------------------------------------------------------------------------------------

test("every catalog ignore line is one Calavera accepts", () => {
  for (const integration of integrationCatalog) {
    for (const [file, lines] of Object.entries(integration.ignore ?? {})) {
      assert.ok(["gitignore", "htmlValidateIgnore"].includes(file), `${integration.id}: ${file}`);
      assert.ok(Array.isArray(lines) && lines.length > 0, `${integration.id}: ${file}`);
      for (const line of lines) {
        assert.equal(ignoreLineProblem(line), undefined, `${integration.id}: ${line}`);
      }
    }
  }
});

test("html-validate declares its own .htmlvalidateignore lines as metadata", () => {
  const htmlValidate = integrationCatalog.find(({ id }) => id === "html-validate");

  assert.deepEqual(htmlValidate?.ignore, {
    htmlValidateIgnore: ["node_modules/", "dist/", "coverage/", ".claude/worktrees/"],
  });
});

test("the state record keeps valid gitignoreBlocks and refuses damaged ones", () => {
  assert.deepEqual(normalizeState({}).gitignoreBlocks, []);
  assert.deepEqual(normalizeState({ gitignoreBlocks: [stryker] }).gitignoreBlocks, [stryker]);
  for (const gitignoreBlocks of [
    {},
    [{ integration: "", lines: [] }],
    [{ integration: "stryker" }],
    [{ integration: "stryker", lines: [1] }],
    [{ integration: "stryker\u001b[2J", lines: [] }],
    [{ integration: "Stryker", lines: [] }],
  ]) {
    assert.throws(
      () => normalizeState({ gitignoreBlocks }),
      /Calavera state contains invalid gitignoreBlocks entries/,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Apply, with a test integration that declares ignore lines. No catalog entry declares
// `.gitignore` lines before the Stryker entry (#734), so the test adds one for this file only.
// ---------------------------------------------------------------------------------------------

const fixtureBlock =
  "# calavera:ignore-fixture:start\n.fixture-tmp/\nreports/fixture/\n# calavera:ignore-fixture:end\n";

const applyOptions = { json: true, noInstall: true, assumeYes: true };

/** @param {string[]} integrations */
const recipeWith = (integrations) => buildRecipe("minimal", integrations, "npm");

/**
 * Runs `callback` in a new temporary project that holds a package.json and, when given, the
 * person's own .gitignore.
 *
 * @param {string | undefined} gitignore
 * @param {(directory: string) => Promise<void>} callback
 */
async function inProject(gitignore, callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-ignore-lines-"));
  const directory = await realpath(project.path);
  const originalDirectory = process.cwd();
  process.chdir(directory);

  try {
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    if (gitignore !== undefined) await writeFile(".gitignore", gitignore);
    await callback(directory);
  } finally {
    process.chdir(originalDirectory);
  }
}

test("apply keeps the person's .gitignore lines in order and appends the integration's block", async () => {
  await inProject(own, async () => {
    const recipe = recipeWith(["ignore-fixture"]);
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    // The dry run lists the lines apply adds, and writes nothing.
    assert.deepEqual(dryRun.ignoreChanges, [
      {
        path: ".gitignore",
        integration: "ignore-fixture",
        type: "update",
        lines: fixture.ignore.gitignore,
      },
    ]);
    assert.ok(
      dryRun.changes.some(
        ({ type, path, action, ownership }) =>
          type === "update" &&
          path === ".gitignore" &&
          action === "merge" &&
          ownership === "project",
      ),
    );
    assert.equal(await readFile(".gitignore", "utf8"), own);

    const mcpDryRun = await callMcpTool("dry_run_apply", { recipe });
    assert.deepEqual(mcpDryRun.result.ignoreChanges, dryRun.ignoreChanges);

    await applyRecipeObject(recipe, applyOptions);

    assert.equal(await readFile(".gitignore", "utf8"), `${own}${fixtureBlock}`);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.gitignoreBlocks, [
      { integration: "ignore-fixture", lines: fixture.ignore.gitignore },
    ]);
    assert.equal(
      state.managedFiles.some(({ path }) => path === ".gitignore"),
      false,
    );
  });
});

test("a second dry run after apply reports no drift", async () => {
  await inProject(undefined, async () => {
    const recipe = recipeWith(["ignore-fixture", "html-validate"]);
    const applied = await applyRecipeObject(recipe, applyOptions);
    assert.equal(await readFile(".gitignore", "utf8").catch(() => undefined), fixtureBlock);

    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.deepEqual(
      dryRun.changes,
      applied.changes.map((change) => ({ ...change, type: "unchanged" })),
    );
    assert.ok(dryRun.ignoreChanges?.length > 0);
    assert.deepEqual(
      dryRun.ignoreChanges?.filter(({ type }) => type !== "unchanged"),
      [],
    );
  });
});

test("removing the integration from the recipe removes only its unedited block", async () => {
  await inProject(own, async () => {
    await applyRecipeObject(recipeWith(["ignore-fixture"]), applyOptions);

    const dryRun = await applyRecipeObject(recipeWith([]), { ...applyOptions, dryRun: true });
    assert.deepEqual(dryRun.ignoreChanges, [
      {
        path: ".gitignore",
        integration: "ignore-fixture",
        type: "update",
        removedLines: fixture.ignore.gitignore,
      },
    ]);
    assert.equal(await readFile(".gitignore", "utf8"), `${own}${fixtureBlock}`);

    await applyRecipeObject(recipeWith([]), applyOptions);

    assert.equal(await readFile(".gitignore", "utf8"), own);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.gitignoreBlocks, []);
  });
});

test("an edited block stops the dry run and apply, and the file keeps the edit", async () => {
  await inProject(own, async () => {
    await applyRecipeObject(recipeWith(["ignore-fixture"]), applyOptions);
    const edited = `${own}# calavera:ignore-fixture:start\n.fixture-tmp/\nmine/\n# calavera:ignore-fixture:end\n`;
    await writeFile(".gitignore", edited);

    for (const recipe of [recipeWith(["ignore-fixture"]), recipeWith([])]) {
      for (const dryRun of [true, false]) {
        await assert.rejects(
          applyRecipeObject(recipe, { ...applyOptions, dryRun }),
          /Calavera stopped before writing anything[\s\S]*\.gitignore: [\s\S]*edited since Calavera wrote it/,
        );
      }
    }
    assert.equal(await readFile(".gitignore", "utf8"), edited);
  });
});

test("with Varlock, apply reports one .gitignore change and keeps both the block and the Varlock lines", async () => {
  await inProject(own, async () => {
    const recipe = recipeWith(["ignore-fixture", "varlock"]);
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
    assert.equal(dryRun.changes.filter(({ path }) => path === ".gitignore").length, 1);

    await applyRecipeObject(recipe, applyOptions);
    const gitignore = await readFile(".gitignore", "utf8");
    assert.ok(gitignore.startsWith(`${own}${fixtureBlock}`), gitignore);
    assert.match(gitignore, /^# Varlock$/m);
    assert.match(gitignore, /^\.env\.local$/m);

    const again = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
    assert.deepEqual(
      again.changes.filter(({ path }) => path === ".gitignore"),
      [{ type: "unchanged", path: ".gitignore", action: "merge", ownership: "project" }],
    );
  });
});

test("apply does not rewrite a .gitignore whose blocks are unchanged", async () => {
  await inProject(own, async () => {
    const recipe = recipeWith(["ignore-fixture"]);
    await applyRecipeObject(recipe, applyOptions);
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(".gitignore", past, past);

    await applyRecipeObject(recipe, applyOptions);

    assert.equal((await stat(".gitignore")).mtimeMs, past.getTime());
  });
});

test("without html-validate, apply plans no .htmlvalidateignore lines", async () => {
  await inProject(undefined, async () => {
    const dryRun = await applyRecipeObject(recipeWith(["ignore-fixture", "editorconfig"]), {
      ...applyOptions,
      dryRun: true,
    });

    assert.deepEqual(
      dryRun.ignoreChanges.filter(({ path }) => path === ".htmlvalidateignore"),
      [],
    );
  });
});

test("with Varlock, the block is written when Varlock merges no .gitignore lines", async () => {
  await inProject(own, async () => {
    await applyRecipeObject(recipeWith(["varlock"]), applyOptions);
    const afterVarlock = await readFile(".gitignore", "utf8");
    // Varlock still plans .env.schema, but not .gitignore, whose lines are already there.
    await rm(".env.schema");

    await applyRecipeObject(recipeWith(["ignore-fixture", "varlock"]), applyOptions);

    assert.equal(await readFile(".gitignore", "utf8"), `${afterVarlock}${fixtureBlock}`);
  });
});

test("with Varlock and no .gitignore, Varlock writes its section as before", async () => {
  await inProject(undefined, async () => {
    await applyRecipeObject(recipeWith(["varlock"]), applyOptions);

    assert.match(await readFile(".gitignore", "utf8"), /^# Varlock\n/);
  });
});

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fixtureModule = new URL("./ignore-fixture-integration.mjs", import.meta.url).href;

/**
 * Runs `apply --dry-run` for `integrations` in the CLI, with the test integration in its catalog,
 * and returns what it printed.
 *
 * @param {string} directory
 * @param {string[]} integrations
 */
async function cliDryRun(directory, integrations) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipeWith(integrations), null, 2)}\n`);
  const run = spawnSync(
    process.execPath,
    ["--import", fixtureModule, cli, "apply", "--dry-run", "--yes", "--no-install"],
    { cwd: directory, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } },
  );
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  return `${run.stdout}${run.stderr}`;
}

test("the CLI dry run prints every line apply adds, keeps, replaces, or removes", async () => {
  const oldBlock =
    "# calavera:ignore-fixture:start\n.fixture-tmp/\n# calavera:ignore-fixture:end\n";
  await inProject(`${own}${oldBlock}`, async (directory) => {
    await mkdir(".calavera");
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify({
        version: 1,
        integrations: ["ignore-fixture"],
        managedFiles: [],
        gitignoreBlocks: [{ integration: "ignore-fixture", lines: [".fixture-tmp/"] }],
      })}\n`,
    );

    const replace = await cliDryRun(directory, ["ignore-fixture", "html-validate"]);
    assert.match(
      replace,
      /Would replace the ignore-fixture block in \.gitignore: "\.fixture-tmp\/" with "\.fixture-tmp\/", "reports\/fixture\/"/,
    );
    assert.match(
      replace,
      /Would add the ignore-fixture lines to \.htmlvalidateignore: "reports\/fixture\/"/,
    );

    await applyRecipeObject(recipeWith(["ignore-fixture", "html-validate"]), applyOptions);
    const unchanged = await cliDryRun(directory, ["ignore-fixture", "html-validate"]);
    assert.match(
      unchanged,
      /\.gitignore already holds the ignore-fixture block: "\.fixture-tmp\/", "reports\/fixture\/"/,
    );

    const removal = await cliDryRun(directory, ["html-validate"]);
    assert.match(
      removal,
      /Would remove the ignore-fixture block from \.gitignore, because ignore-fixture no longer adds lines to it: "\.fixture-tmp\/", "reports\/fixture\/"/,
    );
    assert.match(
      removal,
      /Would remove from \.htmlvalidateignore, because no selected integration declares them: "reports\/fixture\/"/,
    );
  });
});

test("html-validate alone writes the same .htmlvalidateignore as before", async () => {
  await inProject(undefined, async () => {
    await applyRecipeObject(recipeWith(["html-validate"]), applyOptions);

    assert.equal(
      await readFile(".htmlvalidateignore", "utf8"),
      "node_modules/\ndist/\ncoverage/\n.claude/worktrees/\n",
    );
    // No integration declares .gitignore lines, so apply leaves .gitignore alone.
    await assert.rejects(readFile(".gitignore", "utf8"), { code: "ENOENT" });
  });
});

test("an integration's html-validate lines go into .htmlvalidateignore, and leave with it", async () => {
  await inProject(undefined, async () => {
    const recipe = recipeWith(["ignore-fixture", "html-validate"]);
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
    assert.deepEqual(
      dryRun.ignoreChanges?.filter(({ path }) => path === ".htmlvalidateignore"),
      [
        {
          path: ".htmlvalidateignore",
          integration: "html-validate",
          type: "write",
          lines: ["node_modules/", "dist/", "coverage/", ".claude/worktrees/"],
        },
        {
          path: ".htmlvalidateignore",
          integration: "ignore-fixture",
          type: "write",
          lines: ["reports/fixture/"],
        },
      ],
    );

    await applyRecipeObject(recipe, applyOptions);
    assert.equal(
      await readFile(".htmlvalidateignore", "utf8"),
      "node_modules/\ndist/\ncoverage/\n.claude/worktrees/\nreports/fixture/\n",
    );

    const removal = await applyRecipeObject(recipeWith(["html-validate"]), {
      ...applyOptions,
      dryRun: true,
    });
    assert.deepEqual(
      removal.ignoreChanges?.filter(({ path }) => path === ".htmlvalidateignore"),
      [
        {
          path: ".htmlvalidateignore",
          integration: "html-validate",
          type: "unchanged",
          lines: ["node_modules/", "dist/", "coverage/", ".claude/worktrees/"],
        },
        { path: ".htmlvalidateignore", type: "update", removedLines: ["reports/fixture/"] },
      ],
    );
    await applyRecipeObject(recipeWith(["html-validate"]), applyOptions);
    assert.equal(
      await readFile(".htmlvalidateignore", "utf8"),
      "node_modules/\ndist/\ncoverage/\n.claude/worktrees/\n",
    );
  });
});

const validHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Valid</title>
  </head>
  <body>
    <p>Valid</p>
  </body>
</html>
`;
const invalidHtml = validHtml.replace("<p>Valid</p>", "<div></span>");

/**
 * Applies `integrations`, links the workspace's html-validate, writes a valid page and an invalid
 * report under reports/fixture/, and runs the lint:html wrapper apply wrote.
 *
 * @param {string[]} integrations
 */
async function lintReportProject(integrations) {
  let result = { code: /** @type {number | null} */ (null), output: "" };
  await inProject(undefined, async (directory) => {
    await applyRecipeObject(recipeWith(integrations), applyOptions);
    await mkdir(join(directory, "node_modules"), { recursive: true });
    await symlink(
      await packageDirectory("html-validate"),
      join(directory, "node_modules", "html-validate"),
      "junction",
    );
    await writeFile("index.html", validHtml);
    await mkdir(join("reports", "fixture"), { recursive: true });
    await writeFile(join("reports", "fixture", "report.html"), invalidHtml);

    const run = spawnSync(process.execPath, [join("scripts", "lint-html.mjs"), "**/*.html"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    result = { code: run.status, output: `${run.stdout}${run.stderr}` };
  });
  return result;
}

test("an integration's html-validate lines keep the managed lint:html script from linting those paths", async () => {
  // Without the integration's lines, the report fails lint:html, which is the failure in #733.
  const without = await lintReportProject(["html-validate"]);
  assert.equal(without.code, 1, without.output);
  assert.match(without.output, /close-order/);

  const withLines = await lintReportProject(["html-validate", "ignore-fixture"]);
  assert.equal(withLines.code, 0, withLines.output);
});
