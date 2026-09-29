// Issue #548: once a recipe is applied, a second dry run reports each planned
// write and script update as unchanged and does not warn about the files and
// scripts Calavera recorded. Conflicts and foreign files keep their findings.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempDisposable, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { applyRecipeObject, inspectProject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

const recipe = buildRecipe(
  "default",
  ["editorconfig", "stylelint", "knip", "github-repository-controls"],
  "npm",
  [],
  { "github-repository-controls": { repository: "example/unchanged" } },
);

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

/**
 * Runs `callback` in a new temporary project that holds only a package.json.
 *
 * @param {(directory: string) => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-dry-run-unchanged-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await callback(project.path);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {{ kind: string }[]} findings */
function existingFindings(findings) {
  return findings.filter(({ kind }) => kind.startsWith("existing-"));
}

test("a second dry run on an unchanged project reports every change unchanged", async () => {
  await inProject(async () => {
    const applied = await applyRecipeObject(recipe, applyOptions);
    assert.equal(
      applied.changes.some(({ type }) => type === "unchanged"),
      false,
    );

    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.ok(dryRun.changes.length > 0);
    assert.deepEqual(
      dryRun.changes,
      applied.changes.map((change) => ({ ...change, type: "unchanged" })),
    );
    assert.deepEqual(existingFindings(dryRun.projectInspection.findings), []);
    assert.deepEqual(existingFindings((await inspectProject(recipe)).findings), []);
  });
});

test("apply after an unchanged dry run rewrites none of the unchanged files", async () => {
  await inProject(async () => {
    const applied = await applyRecipeObject(recipe, applyOptions);
    const paths = applied.changes.map(({ path }) => path);
    const past = new Date("2020-01-01T00:00:00Z");

    for (const path of paths) {
      await utimes(path, past, past);
    }

    const reapplied = await applyRecipeObject(recipe, applyOptions);

    assert.ok(reapplied.changes.every(({ type }) => type === "unchanged"));
    for (const path of paths) {
      assert.equal((await stat(path)).mtimeMs, past.getTime(), `${path} was rewritten`);
    }
  });
});

test("the CLI dry run names each unchanged file and says there is nothing to change", async () => {
  await inProject(async () => {
    await applyRecipeObject(recipe, applyOptions);

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "apply", "--dry-run"], {
      env: { ...process.env, NO_COLOR: "1" },
    });

    assert.match(stdout, /Unchanged \.editorconfig/);
    assert.match(stdout, /Unchanged package\.json/);
    assert.match(stdout, /Scripts already set: lint, lint:fix, knip/);
    assert.match(stdout, /Nothing to change: the project already matches this recipe\./);
    assert.doesNotMatch(stdout, /Would (write|update)/);
  });
});

test("a managed file with local edits still yields managed-file-conflict", async () => {
  await inProject(async () => {
    await applyRecipeObject(recipe, applyOptions);
    await writeFile(".editorconfig", "local edits\n");

    const inspection = await inspectProject(recipe);

    assert.ok(
      inspection.findings.some(
        ({ kind, path, severity }) =>
          kind === "managed-file-conflict" && path === ".editorconfig" && severity === "error",
      ),
    );
    await assert.rejects(
      () => applyRecipeObject(recipe, { ...applyOptions, dryRun: true }),
      /Refusing to overwrite existing managed file: \.editorconfig/,
    );
    assert.equal(await readFile(".editorconfig", "utf8"), "local edits\n");
  });
});

test("a foreign .editorconfig that Calavera did not record still yields existing-config", async () => {
  await inProject(async () => {
    await applyRecipeObject(recipe, applyOptions);

    // .editorconfig keeps exactly the contents Calavera would write, but state
    // no longer records it, so it is a foreign file.
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    const managedFiles = state.managedFiles.filter(({ path }) => path !== ".editorconfig");
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify(
        { ...state, files: managedFiles.map(({ path }) => path), managedFiles },
        null,
        2,
      )}\n`,
    );

    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.deepEqual(
      existingFindings(dryRun.projectInspection.findings).map(({ kind, path }) => ({
        kind,
        path,
      })),
      [{ kind: "existing-config", path: ".editorconfig" }],
    );
    assert.equal(dryRun.changes.find(({ path }) => path === ".editorconfig")?.type, "write");
  });
});

test("a recorded script the user changed keeps the existing-package-script warning and is replaced", async () => {
  await inProject(async () => {
    await applyRecipeObject(recipe, applyOptions);
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    const lint = packageJSON.scripts.lint;
    packageJSON.scripts.lint = "stylelint src";
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);

    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.deepEqual(
      existingFindings(dryRun.projectInspection.findings).map(({ kind, message }) => ({
        kind,
        message,
      })),
      [
        {
          kind: "existing-package-script",
          message:
            'package.json already defines "lint"; Calavera will replace that script if this recipe is applied.',
        },
      ],
    );
    assert.equal(dryRun.changes.find(({ path }) => path === "package.json")?.type, "update");

    await applyRecipeObject(recipe, applyOptions);
    assert.equal(JSON.parse(await readFile("package.json", "utf8")).scripts.lint, lint);
  });
});
