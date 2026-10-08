// Issue #623: the dry run is the approval boundary, so it shows the command
// each added or changed package.json script will run, and for a changed script
// the command it runs now, in the human output, `--json`, and `dry_run_apply`.
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

// The recipe names npm; every dry run below passes pnpm explicitly, so the
// quality value shows that the dry run uses the package manager apply uses.
const recipe = buildRecipe("default", ["stylelint", "knip"], "npm");

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
  { script: "lint:styles", value: 'stylelint "**/*.{css,scss}"' },
  { script: "lint:styles:fix", value: 'stylelint "**/*.{css,scss}" --fix' },
  { script: "quality", value: "pnpm lint:styles && pnpm knip", previous: userQuality },
];

/**
 * Runs `callback` in a new temporary project that holds the package.json above
 * and the recipe as calavera.config.json.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-dry-run-scripts-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);
    await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
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
    assert.ok(
      lines.includes(
        `Would change script quality from "${userQuality}" to "pnpm lint:styles && pnpm knip"`,
      ),
    );
    assert.ok(lines.includes("Scripts already set: knip"));
    assert.doesNotMatch(stdout, /Would (add|change) script knip/);
    assert.doesNotMatch(stdout, /Would add scripts:/);
    assert.equal(stdout.includes(secretValue), false);
  });
});

test("apply reports the script changes its dry run showed, and a dry run after it lists none", async () => {
  await inProject(async () => {
    const options = { json: true, noInstall: true, assumeYes: true, packageManager: "pnpm" };
    const dryRun = await applyRecipeObject(recipe, { ...options, dryRun: true });
    const applied = await applyRecipeObject(recipe, options);
    const written = JSON.parse(await readFile("package.json", "utf8")).scripts;

    assert.deepEqual(dryRun.scriptChanges, expectedScriptChanges);
    assert.deepEqual(applied.scriptChanges, dryRun.scriptChanges);
    for (const { script, value } of dryRun.scriptChanges) {
      assert.equal(written[script], value, `${script} was not written as the dry run showed`);
    }

    const secondDryRun = await applyRecipeObject(recipe, { ...options, dryRun: true });

    assert.equal(packageJSONChange(secondDryRun.changes).type, "unchanged");
    assert.deepEqual(secondDryRun.scriptChanges, []);
  });
});
