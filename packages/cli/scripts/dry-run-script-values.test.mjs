// Issue #623: the dry run is the approval boundary, so it shows the command
// each added, changed, or renamed package.json script will run, and for a
// changed or renamed script the command it runs now, in the human output,
// `--json`, and `dry_run_apply`. Apply reports the same script changes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

// The recipe names npm; every run below passes pnpm explicitly, so the quality
// value shows that the dry run uses the package manager apply uses.
const recipe = buildRecipe("default", ["stylelint", "knip"], "npm");
const lintStyles = 'stylelint "**/*.{css,scss}"';
const lintStylesFix = 'stylelint "**/*.{css,scss}" --fix';
const quality = "pnpm lint:styles && pnpm knip";

// A user-defined command that names an environment variable. The dry run
// shows it as written and never expands the variable.
const secretName = "CALAVERA_TEST_623_SECRET";
const secretValue = "expanded-secret-value";
const userQuality = `echo $${secretName}`;

const packageJSON = {
  scripts: {
    // Unchanged: the value Calavera would write.
    knip: "knip",
    // Changed: Calavera replaces this value.
    quality: userQuality,
    // lint:styles and lint:styles:fix are absent, so they are added.
  },
};

const expectedScriptChanges = [
  { script: "lint:styles", value: lintStyles },
  { script: "lint:styles:fix", value: lintStylesFix },
  { script: "quality", value: quality, previous: userQuality },
];

const applyOptions = { json: true, noInstall: true, assumeYes: true, packageManager: "pnpm" };

/**
 * Runs `callback` in a new temporary project that holds `manifest` as
 * package.json and the recipe as calavera.config.json.
 *
 * @param {() => Promise<void>} callback
 * @param {unknown} [manifest]
 */
async function inProject(callback, manifest = packageJSON) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-dry-run-scripts-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    await writeManifest(manifest);
    await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {unknown} manifest */
async function writeManifest(manifest) {
  await writeFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

/** @param {{ path: string, type: string }[]} changes */
function packageJSONChange(changes) {
  return changes.find(({ path }) => path === "package.json");
}

/** @param {string[]} cliArgs */
async function runCli(cliArgs) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, NO_COLOR: "1", [secretName]: secretValue },
  });
  return stdout;
}

test("the --json dry run lists added and changed scripts with their values", async () => {
  await inProject(async () => {
    const result = JSON.parse(
      await runCli(["apply", "--dry-run", "--json", "--package-manager", "pnpm"]),
    );
    const change = packageJSONChange(result.changes);

    assert.equal(result.packageManager, "pnpm");
    assert.equal(change.type, "update");
    assert.deepEqual(result.scriptChanges, expectedScriptChanges);
    // The scripts field keeps every script name Calavera plans, as before.
    assert.deepEqual(change.scripts, ["lint:styles", "lint:styles:fix", "knip", "quality"]);
    assert.equal(JSON.stringify(result).includes(secretValue), false);
    assert.deepEqual(JSON.parse(await readFile("package.json", "utf8")), packageJSON);
  });
});

test("dry_run_apply lists added and changed scripts with their values", async () => {
  await inProject(async () => {
    const response = await callMcpTool("dry_run_apply", { recipe, packageManager: "pnpm" });
    assert.equal(packageJSONChange(response.result.changes).type, "update");
    assert.deepEqual(response.result.scriptChanges, expectedScriptChanges);
    assert.deepEqual(JSON.parse(await readFile("package.json", "utf8")), packageJSON);
  });
});

test("the human dry run shows each added and changed script, and names the unchanged ones", async () => {
  await inProject(async () => {
    const stdout = await runCli(["apply", "--dry-run", "--package-manager", "pnpm"]);
    const lines = stdout.split("\n");

    assert.ok(lines.includes('Would add script lint:styles: "stylelint \\"**/*.{css,scss}\\""'));
    assert.ok(
      lines.includes('Would add script lint:styles:fix: "stylelint \\"**/*.{css,scss}\\" --fix"'),
    );
    assert.ok(lines.includes(`Would change script quality from "${userQuality}" to "${quality}"`));
    assert.ok(lines.includes("Scripts already set: knip"));
    assert.doesNotMatch(stdout, /Would (add|change) script knip/);
    assert.doesNotMatch(stdout, /Would add scripts:/);
    assert.equal(stdout.includes(secretValue), false);
  });
});

test("apply reports the script changes its dry run showed, and a dry run after it lists none", async () => {
  await inProject(async () => {
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
    const applied = await applyRecipeObject(recipe, applyOptions);
    const written = JSON.parse(await readFile("package.json", "utf8")).scripts;

    assert.deepEqual(dryRun.scriptChanges, expectedScriptChanges);
    assert.deepEqual(applied.scriptChanges, dryRun.scriptChanges);
    for (const { script, value } of dryRun.scriptChanges) {
      assert.equal(written[script], value, `${script} was not written as the dry run showed`);
    }

    const secondDryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.equal(packageJSONChange(secondDryRun.changes).type, "unchanged");
    assert.deepEqual(secondDryRun.scriptChanges, []);
  });
});

test("apply --json carries the script changes apply --dry-run --json showed", async () => {
  await inProject(async () => {
    const cliArgs = ["apply", "--json", "--no-install", "--package-manager", "pnpm"];
    const dryRun = JSON.parse(await runCli([...cliArgs, "--dry-run"]));
    const applied = JSON.parse(await runCli(cliArgs));

    assert.equal(applied.dryRun, false);
    assert.deepEqual(applied.scriptChanges, expectedScriptChanges);
    assert.deepEqual(applied.scriptChanges, dryRun.scriptChanges);
  });
});

test("apply_recipe carries the script changes dry_run_apply showed", async () => {
  await inProject(async () => {
    const input = { recipe, packageManager: "pnpm" };
    const dryRun = await callMcpTool("dry_run_apply", input);
    const applied = await callMcpTool("apply_recipe", { ...input, noInstall: true });

    assert.deepEqual(applied.result.scriptChanges, expectedScriptChanges);
    assert.deepEqual(applied.result.scriptChanges, dryRun.result.scriptChanges);
  });
});

test("a renamed script is one entry with its old name and value, and one human line", async () => {
  // A value an earlier release wrote for lint, which apply renames.
  const legacyLint = `eslint . && ${lintStyles}`;

  await inProject(async () => {
    await applyRecipeObject(recipe, applyOptions);
    const {
      "lint:styles": _lint,
      "lint:styles:fix": _lintFix,
      ...rest
    } = JSON.parse(await readFile("package.json", "utf8")).scripts;
    await writeManifest({
      scripts: { lint: legacyLint, "lint:fix": lintStylesFix, ...rest },
    });

    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.deepEqual(dryRun.scriptChanges, [
      { script: "lint:styles", value: lintStyles, renamedFrom: "lint", previous: legacyLint },
      {
        script: "lint:styles:fix",
        value: lintStylesFix,
        renamedFrom: "lint:fix",
        previous: lintStylesFix,
      },
    ]);
    // The rename data on the package.json change is unchanged.
    assert.deepEqual(packageJSONChange(dryRun.changes).renamedScripts, [
      { from: "lint", to: "lint:styles" },
      { from: "lint:fix", to: "lint:styles:fix" },
    ]);

    const stdout = await runCli(["apply", "--dry-run", "--package-manager", "pnpm"]);
    const lines = stdout.split("\n");

    assert.ok(
      lines.includes('Would rename script lint to lint:styles: "stylelint \\"**/*.{css,scss}\\""'),
    );
    assert.ok(
      lines.includes(
        'Would rename script lint:fix to lint:styles:fix: "stylelint \\"**/*.{css,scss}\\" --fix"',
      ),
    );
    assert.equal(lines.filter((line) => line.startsWith("Would rename script")).length, 2);
    assert.doesNotMatch(stdout, /Would add script lint:styles/);
  });
});

test("the human dry run escapes control and format characters in script values", async () => {
  const hostile = "echo \u001b[31mred\u202ereversed\u2028next\u007f";

  await inProject(
    async () => {
      const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
      assert.equal(
        dryRun.scriptChanges.find(({ script }) => script === "quality").previous,
        hostile,
      );

      const stdout = await runCli(["apply", "--dry-run", "--package-manager", "pnpm"]);

      assert.ok(
        stdout
          .split("\n")
          .includes(
            `Would change script quality from "echo \\u001b[31mred\\u202ereversed\\u2028next\\u007f" to "${quality}"`,
          ),
      );
      for (const character of ["\u001b", "\u202e", "\u2028", "\u007f"]) {
        assert.equal(
          stdout.includes(character),
          false,
          `stdout holds U+${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
        );
      }
    },
    { scripts: { quality: hostile } },
  );
});

test("a script whose current value is not a string shows that value", async () => {
  await inProject(
    async () => {
      const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
      assert.deepEqual(
        dryRun.scriptChanges.find(({ script }) => script === "quality"),
        { script: "quality", value: quality, previous: 42 },
      );

      const stdout = await runCli(["apply", "--dry-run", "--package-manager", "pnpm"]);

      assert.ok(stdout.split("\n").includes(`Would change script quality from 42 to "${quality}"`));
    },
    { scripts: { quality: 42 } },
  );
});
