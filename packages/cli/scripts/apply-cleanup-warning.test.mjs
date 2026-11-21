// Issue #1033: removing a temporary folder can fail after apply has written the AI outputs. The
// owner decided on 2026-11-18 that this is a warning: apply still writes the config, the scripts,
// and the state, names the folder to remove, and fails only when something else fails. The dry run
// treats the same failure the same way.
import assert from "node:assert/strict";
import fsPromises, { mkdtempDisposable, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { applySummaryLines } from "../src/apply-summary.js";
import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";
import { writePackageManagerStubs } from "./vite-plus-fixtures.mjs";

const ID = "skill-project-goal";
const CONFIG = "calavera.config.json";
const STATE = ".calavera/state.json";
const MANIFEST = `${JSON.stringify({ name: "fixture", scripts: {} }, null, 2)}\n`;
// Text an error message can carry, such as a path from the person's configuration, which a reason
// must never repeat.
const SECRET = "npm_token_in_message";

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: CONFIG,
};

const recipe = { ...buildRecipe("minimal", [], "npm"), ai: [{ id: ID }] };

/**
 * Runs `callback` in a new project where apply has installed and locked `skill-project-goal`.
 *
 * @param {(registry: ReturnType<typeof stubRegistry>) => Promise<void>} callback
 */
async function inAppliedProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-cleanup-warning-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    await writeFile("package.json", MANIFEST);
    const registry = stubRegistry(new Map([[ID, "0.1.0"]]));
    await applyRecipeObject(structuredClone(recipe), applyOptions, registry);
    await callback(registry);
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * Makes removing each folder Calavera creates to rebuild a locked package fail with EBUSY, and
 * records those folders. Every other removal runs as usual.
 *
 * @param {import("node:test").TestContext} t
 */
function failRebuildFolderRemoval(t) {
  const { mkdtemp, rm: remove } = fsPromises;
  /** @type {string[]} */
  const folders = [];
  t.mock.method(fsPromises, "mkdtemp", async (/** @type {string} */ prefix, ...rest) => {
    const folder = await mkdtemp(prefix, ...rest);
    if (prefix.includes("calavera-locked-artifact-")) folders.push(folder);
    return folder;
  });
  t.mock.method(fsPromises, "rm", (/** @type {string} */ path, ...rest) =>
    folders.includes(path)
      ? Promise.reject(
          Object.assign(new Error(`EBUSY: resource busy, ${SECRET}, rmdir '${path}'`), {
            code: "EBUSY",
            path,
          }),
        )
      : remove(path, ...rest),
  );
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  });
  return folders;
}

/** @param {string} folder */
const leftover = (folder) => ({
  path: folder,
  reason:
    "Calavera could not remove this temporary folder (EBUSY). Nothing in the project uses it, so remove it yourself.",
});

test("apply finishes and names the temporary folder it could not remove after writing the AI outputs", async (t) => {
  await inAppliedProject(async (registry) => {
    const applied = await snapshot();
    // The package is rebuilt in a temporary folder, and the config, scripts, and state are taken
    // back to what they were before the first apply, so this apply has to write each of them.
    await rm(".calavera/packages", { recursive: true });
    await rm(CONFIG);
    await writeFile("package.json", MANIFEST);
    await writeFile(STATE, JSON.stringify(JSON.parse(await readFile(STATE, "utf8"))));
    const folders = failRebuildFolderRemoval(t);

    const result = await applyRecipeObject(structuredClone(recipe), applyOptions, registry);

    assert.equal(folders.length, 1, "apply rebuilds the missing package once");
    assert.deepEqual(result.temporaryFolderLeftovers, [leftover(folders[0])]);
    assert.ok((await stat(folders[0])).isDirectory(), "the folder was not left as reported");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    // Apply wrote everything a run without the cleanup failure writes.
    assert.deepEqual(await snapshot(), applied);

    const lines = applySummaryLines(result);
    assert.deepEqual(lines.at(-1), {
      level: "warn",
      text: `  Not removed ${folders[0]}: ${leftover(folders[0]).reason}`,
    });
    assert.ok(
      lines.findIndex(({ text }) => text === "Notes:") < lines.length - 1,
      "the warning is not under Notes",
    );
  });
});

test("the dry run finishes and names the temporary folder it could not remove", async (t) => {
  await inAppliedProject(async (registry) => {
    await rm(".calavera/packages", { recursive: true });
    const before = await snapshot();
    const folders = failRebuildFolderRemoval(t);

    const result = await applyRecipeObject(
      structuredClone(recipe),
      { ...applyOptions, dryRun: true },
      registry,
    );

    assert.equal(folders.length, 1, "the dry run rebuilds the missing package once");
    assert.deepEqual(result.temporaryFolderLeftovers, [leftover(folders[0])]);
    assert.deepEqual(await snapshot(), before);
  });
});

test("apply reports no leftover temporary folder when every removal succeeds", async () => {
  await inAppliedProject(async (registry) => {
    await rm(".calavera/packages", { recursive: true });

    const result = await applyRecipeObject(structuredClone(recipe), applyOptions, registry);

    assert.deepEqual(result.temporaryFolderLeftovers, []);
  });
});

test("an install that fails after a cleanup failure names the folder with what apply wrote", async (t) => {
  await inAppliedProject(async (registry) => {
    await rm(".calavera/packages", { recursive: true });
    // The npm stand-in fails, so apply installs nothing.
    await using tools = await mkdtempDisposable(join(tmpdir(), "calavera-cleanup-warning-tools-"));
    await writePackageManagerStubs(join(tools.path, "bin"));
    const environment = { ...process.env };
    t.after(() => {
      process.env = environment;
    });
    process.env.PATH = `${join(tools.path, "bin")}${delimiter}${process.env.PATH ?? ""}`;
    process.env.STUB_LOG = join(tools.path, "package-manager.log");
    process.env.STUB_EXIT = "1";
    const folders = failRebuildFolderRemoval(t);

    await assert.rejects(
      applyRecipeObject(
        structuredClone({ ...recipe, integrations: ["knip"] }),
        { ...applyOptions, noInstall: false },
        registry,
      ),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /could not install the recipe's development dependencies/);
        assert.match(
          error.message,
          new RegExp(
            `^Not removed ${folders[0]}: Calavera could not remove this temporary folder \\(EBUSY\\)\\. Nothing in the project uses it, so remove it yourself\\.$`,
            "m",
          ),
        );
        assert.doesNotMatch(error.message, new RegExp(SECRET));
        return true;
      },
    );
    assert.notEqual(await readFile(process.env.STUB_LOG, "utf8"), "", "apply ran no install");
  });
});

test("a write that fails after a cleanup failure names the folder with its own error", async (t) => {
  await inAppliedProject(async (registry) => {
    await rm(".calavera/packages", { recursive: true });
    const folders = failRebuildFolderRemoval(t);
    const write = fsPromises.writeFile;
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    t.mock.method(fsPromises, "writeFile", (/** @type {string} */ path, ...rest) =>
      path === STATE ? Promise.reject(denied) : write(path, ...rest),
    );
    syncBuiltinESMExports();

    await assert.rejects(
      applyRecipeObject(structuredClone(recipe), applyOptions, registry),
      (/** @type {AggregateError} */ error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], denied);
        assert.equal(error.cause, denied);
        assert.equal(
          error.message,
          `EACCES: permission denied\nNot removed ${folders[0]}: ${leftover(folders[0]).reason}`,
        );
        return true;
      },
    );
  });
});
